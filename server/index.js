const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3001;

// ========== AI标注任务队列管理器 ==========
// 非管理员用户最多同时10个并发任务
const MAX_CONCURRENT_TASKS = 10;

class AnnotationTaskQueue {
  constructor() {
    this.runningTasks = new Map(); // 正在执行的任务: taskId -> { imageId, startTime, sessionId }
    this.waitingQueue = []; // 等待队列: [{ taskId, imageId, modelParams, req, res, sessionId, timestamp }]
    this.taskIdCounter = 0;
  }

  // 生成唯一任务ID
  generateTaskId() {
    return `task_${Date.now()}_${++this.taskIdCounter}`;
  }

  // 获取当前运行中的任务数（非管理员）
  getRunningTaskCount() {
    return this.runningTasks.size;
  }

  // 获取排队位置
  getQueuePosition(taskId) {
    const index = this.waitingQueue.findIndex(t => t.taskId === taskId);
    return index >= 0 ? index + 1 : null;
  }

  // 添加任务（如果未达到并发限制，立即执行；否则加入队列）
  async addTask(imageId, modelParams, req, res, isAdmin) {
    const taskId = this.generateTaskId();
    const sessionId = req.sessionID;

    // 管理员不受限制
    if (isAdmin) {
      // 管理员任务直接执行，不加入队列
      this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });
      return { taskId, immediate: true };
    }

    // 非管理员用户：检查并发限制
    if (this.runningTasks.size < MAX_CONCURRENT_TASKS) {
      // 有空闲位置，立即执行
      this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });
      return { taskId, immediate: true };
    } else {
      // 已达到并发限制，加入队列
      const queuePosition = this.waitingQueue.length + 1;
      this.waitingQueue.push({
        taskId,
        imageId,
        modelParams,
        req,
        res,
        sessionId,
        timestamp: Date.now()
      });
      console.log(`[任务队列] 任务 ${taskId} (imageId=${imageId}) 已加入队列，当前排队位置: ${queuePosition}`);
      return { taskId, immediate: false, queuePosition };
    }
  }

  // 完成任务，从运行列表移除，并处理队列中的下一个任务
  completeTask(taskId) {
    if (this.runningTasks.has(taskId)) {
      this.runningTasks.delete(taskId);
      console.log(`[任务队列] 任务 ${taskId} 已完成，当前运行中任务数: ${this.runningTasks.size}`);
      
      // 处理队列中的下一个任务
      this.processNextInQueue();
    }
  }

  // 处理队列中的下一个任务
  async processNextInQueue() {
    if (this.waitingQueue.length === 0) {
      return;
    }

    if (this.runningTasks.size >= MAX_CONCURRENT_TASKS) {
      return; // 仍然没有空闲位置
    }

    // 取出队列中的第一个任务
    const nextTask = this.waitingQueue.shift();
    if (!nextTask) return;

    const { taskId, imageId, modelParams, req, res, sessionId } = nextTask;
    
    console.log(`[任务队列] 开始处理队列中的任务 ${taskId} (imageId=${imageId})`);
    
    // 将任务加入运行列表
    this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });

    // 执行任务（调用实际的标注处理函数）
    this.executeTask(taskId, imageId, modelParams, req, res).catch(err => {
      console.error(`[任务队列] 任务 ${taskId} 执行失败:`, err);
      this.completeTask(taskId);
    });
  }

  // 执行标注任务（实际的标注逻辑）
  async executeTask(taskId, imageId, modelParams, req, res) {
    try {
      // 调用原来的标注处理逻辑
      const result = await processAnnotationTask(imageId, modelParams, req);
      
      // 如果响应还没有发送，发送结果
      if (!res.headersSent) {
        res.json(result);
      }
      
      // 任务完成
      this.completeTask(taskId);
    } catch (error) {
      console.error(`[任务队列] 任务 ${taskId} 执行出错:`, error);
      
      // 如果响应还没有发送，发送错误
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: '自动标注失败',
          error: error.message
        });
      }
      
      // 任务完成（即使失败也要从运行列表移除）
      this.completeTask(taskId);
    }
  }

  // 获取队列状态
  getStatus() {
    return {
      running: this.runningTasks.size,
      waiting: this.waitingQueue.length,
      maxConcurrent: MAX_CONCURRENT_TASKS
    };
  }
}

// 全局任务队列实例
const annotationQueue = new AnnotationTaskQueue();

// 中间件配置
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Session 配置
app.use(session({
  secret: process.env.SESSION_SECRET || 'dax-autolabeling-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 本地 Docker (http://localhost:8080) 下不能使用 secure，否则浏览器不会保存 Cookie
    // 通过环境变量显式控制，默认关闭；将来线上如果有 HTTPS，可以在部署时设置 SESSION_COOKIE_SECURE=true
    secure: process.env.SESSION_COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7天
  }
}));

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 获取项目文件夹路径的辅助函数
function getProjectUploadDir(projectId) {
  if (!projectId) {
    // 如果没有项目ID，使用根目录（向后兼容）
    return path.join(__dirname, 'uploads');
  }
  // 使用项目ID作为文件夹名，避免中文乱码
  const projectDir = path.join(__dirname, 'uploads', `project_${projectId}`);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  return projectDir;
}

// 根据 file_path 构建 URL 的辅助函数
function buildImageUrl(filePath, filename) {
  // ⚠️ 不要丢弃子目录（例如 project_<id>/depth/...、project_<id>/meshes/...）
  // 正确做法：按真实 filePath 相对 uploads 目录计算 URL
  const uploadsDir = path.join(__dirname, 'uploads');

  if (filePath) {
    try {
      const rel = path.relative(uploadsDir, filePath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        // encode 每个 path segment，保留斜杠
        const encoded = rel
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        return `/uploads/${encoded}`;
      }
    } catch (e) {
      // ignore, fallback below
    }
  }

  // fallback：仅文件名
  return `/uploads/${encodeURIComponent(filename)}`;
}

// 根据目录路径构建 /uploads/<dir>/ 的 URL（用于 Mesh 资源包目录）
function buildUploadsDirUrl(dirPath) {
  const uploadsDir = path.join(__dirname, 'uploads');
  if (!dirPath) return '/uploads/';
  try {
    const rel = path.relative(uploadsDir, dirPath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) {
      const encoded = rel
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      return `/uploads/${encoded}/`;
    }
  } catch (_) {}
  return '/uploads/';
}

// 文件上传配置
// 注意：multer 的 destination 在文件解析前执行，req.body 可能还没有值
// 所以我们先保存到临时位置，然后在处理中移动到项目文件夹
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// 上传中间件：
// - 单个文件（图片或 ZIP）最大 3GB（主要限制 ZIP 体积，避免一次性塞入过多数据）
// - 单次上传文件数量在具体路由中通过 upload.array('images', MAX_FILES_PER_UPLOAD) 控制
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 3 * 1024 * 1024 * 1024, // 单个文件最大 3GB
  }
});

// ======================================
// 9D Pose Mesh Upload (OBJ + assets)
// ======================================
// 说明：
// - 与图片上传类似：先统一落盘到 uploads 根目录，再在路由中按 projectId 移动到项目子目录
// - 最终落盘路径：server/uploads/project_<projectId>/meshes/
const meshStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 同图片逻辑：统一放在 uploads 根目录，后续再根据 projectId 移动
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const original = String(file.originalname || 'mesh.obj');
    const ext = (path.extname(original) || '.obj').toLowerCase();
    const base = path.basename(original, path.extname(original) || ext).replace(/[^\w.\-() ]+/g, '_');
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${base}-${uniqueSuffix}${ext}`);
  },
});

const meshUpload = multer({
  storage: meshStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 单个 OBJ 默认 200MB
  fileFilter: (req, file, cb) => {
    const ext = String(path.extname(file.originalname || '')).toLowerCase();
    // 允许 OBJ + MTL + 常见贴图资源一起上传（贴图/材质必须与 OBJ 同目录，才能被 three.js 正确解析）
    // 注意：深度数据走 /api/depth/upload，不要在这里传 depth_*.png / *.npy
    const allowed = new Set([
      '.obj',
      '.mtl',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.bmp',
      '.tga',
      '.gif',
    ]);
    if (allowed.has(ext)) return cb(null, true);
    cb(new Error(`不支持的 Mesh 资源类型: ${ext || '(无扩展名)'}；请上传 .obj/.mtl 及贴图图片`));
  },
});

// Depth upload storage（与 mesh 一样先落盘到 uploads 根目录）
const depthStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const original = String(file.originalname || 'depth.dat');
    const ext = (path.extname(original) || '').toLowerCase();
    const base = path.basename(original, ext || undefined).replace(/[^\w.\-() ]+/g, '_');
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${base}-${uniqueSuffix}${ext || ''}`);
  },
});

const depthUpload = multer({
  storage: depthStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 默认单个深度文件 500MB
  fileFilter: (req, file, cb) => {
    const ext = String(path.extname(file.originalname || '')).toLowerCase();
    // 支持深度图和原始深度数据
    if (['.png', '.tif', '.tiff'].includes(ext)) return cb(null, true);
    if (ext === '.npy') return cb(null, true);
    cb(new Error('仅支持深度图 PNG/TIFF 或 .npy 原始深度数据'));
  },
});

// 统一的 RGB/Depth 命名归一化：去掉前缀 depth_/depth_raw_/rgb_ 和扩展名，只留下“语义部分”
function normalizeDepthKey(name) {
  if (!name) return '';
  const base = String(name).replace(/\\/g, '/').split('/').pop() || String(name);
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/^(depth_raw_|depth_|rgb_)/i, '');
}

// ZIP 解压进度 job（内存态：重启会丢失，够用来显示进度）
// job = { id, status, message, zipOriginalName, total, processed, files: Image[], error? }
const uploadJobs = new Map();

function makeJobId() {
  return `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
}

function getIsImageFile(name) {
  const ext = (path.extname(name || '').toLowerCase() || '').replace('.', '');
  return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp'].includes(ext);
}

function safeBaseName(name) {
  const base = path.basename(name || 'image');
  // 简单清洗：只保留常见字符
  return base.replace(/[^\w.\-()\s]/g, '_');
}

function insertImageAsync(fileInfo) {
  return new Promise((resolve, reject) => {
    db.insertImage(fileInfo, (err, imageId) => {
      if (err) return reject(err);
      resolve(imageId);
    });
  });
}

function linkImageToProjectAsync(projectId, imageId) {
  return new Promise((resolve) => {
    if (!projectId) return resolve();
    db.linkImageToProject(projectId, imageId, (err) => {
      if (err) {
        console.error('关联图片到项目失败:', err);
      }
      resolve();
    });
  });
}

async function runZipExtractJob({ jobId, zipPath, zipOriginalName, projectId }) {
  const job = uploadJobs.get(jobId);
  if (!job) return;

  job.status = 'extracting';
  job.message = '正在解压...';

  // 使用项目文件夹
  const uploadDir = getProjectUploadDir(projectId);
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);

    // 安全限制：最多处理 2000 个文件，最多 3GB 解压后体积（防 zip bomb）
    const MAX_FILES = 2000;
    const MAX_TOTAL_UNCOMPRESSED = 3 * 1024 * 1024 * 1024; // 3GB

    const imageEntries = entries.filter((e) => getIsImageFile(e.entryName)).slice(0, MAX_FILES);
    let totalBytes = 0;
    for (const e of imageEntries) {
      const size = Number(e.header?.size || 0);
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
        throw new Error('压缩包内容过大（解压后体积超过限制），请拆分后再上传');
      }
    }

    job.total = imageEntries.length;
    job.processed = 0;
    job.files = [];

    if (job.total === 0) {
      job.status = 'completed';
      job.message = '压缩包中未找到可用图片';
      return;
    }

    for (const entry of imageEntries) {
      // 写入文件
      const orig = safeBaseName(entry.entryName);
      const ext = path.extname(orig);
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const filename = `images-${uniqueSuffix}${ext}`;
      const outPath = path.join(uploadDir, filename);

      const data = entry.getData();
      fs.writeFileSync(outPath, data);

      // 构建相对路径的URL（如果是在项目文件夹中，需要包含项目文件夹路径）
      const relativePath = projectId 
        ? `project_${projectId}/${filename}`
        : filename;

      const fileInfo = {
        filename,
        originalName: orig,
        path: outPath,
        url: `/uploads/${encodeURIComponent(relativePath)}`,
        size: data.length,
        uploadTime: new Date().toISOString(),
      };

      // 入库 + 关联项目
      const imageId = await insertImageAsync(fileInfo);
      fileInfo.id = imageId;
      await linkImageToProjectAsync(projectId, imageId);

      job.files.push(fileInfo);
      job.processed += 1;
      job.message = `正在解压... (${job.processed}/${job.total})`;
    }

    job.status = 'completed';
    job.message = '解压完成';
  } catch (e) {
    console.error('[ZIP] 解压失败:', e);
    job.status = 'error';
    job.error = e?.message || String(e);
    job.message = '解压失败';
  } finally {
    try {
      fs.unlinkSync(zipPath);
    } catch (_) {}
  }
}

// ========== 工具函数 ==========
// 生成验证码（6位大写字母+数字）
function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的字符
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ========== 权限检查中间件 ==========
// 检查是否为管理员
const requireAdmin = (req, res, next) => {
  if (req.session && req.session.userId && req.session.isAdmin) {
    return next();
  }

  // 调试日志：观察 Docker 环境下 session 情况
  console.warn('[requireAdmin] 未通过管理员校验', {
    sessionID: req.sessionID,
    hasSession: !!req.session,
    userId: req.session?.userId,
    isAdmin: req.session?.isAdmin,
  });

  res.status(401).json({ error: '需要管理员权限' });
};

// 检查是否有项目访问权限
const requireProjectAccess = async (req, res, next) => {
  const projectId = req.params.id || req.body.projectId || req.query.projectId;
  if (!projectId) {
    return res.status(400).json({ error: '缺少项目ID' });
  }
  
  // 如果是管理员，直接通过
  if (req.session && req.session.isAdmin) {
    return next();
  }
  
  // 检查项目是否锁定
  try {
    const project = await db.getProjectById(projectId);
    if (project && project.locked) {
      return res.status(403).json({ error: '项目已锁定，请联系管理员' });
    }
  } catch (err) {
    console.error('[检查项目锁定状态] 错误:', err);
  }
  
  const sessionId = req.sessionID;
  const hasAccess = await db.hasProjectAccess(sessionId, projectId);
  
  if (hasAccess) {
    next();
  } else {
    res.status(403).json({ error: '没有访问该项目的权限，请先输入验证码' });
  }
};

// 检查图片所属项目的访问权限
const requireImageProjectAccess = async (req, res, next) => {
  const imageId = req.params.imageId || req.params.id;
  if (!imageId) {
    return res.status(400).json({ error: '缺少图片ID' });
  }
  
  // 如果是管理员，直接通过
  if (req.session && req.session.isAdmin) {
    return next();
  }
  
  try {
    // 查找图片所属的项目
    const image = await new Promise((resolve, reject) => {
      db.getImageById(imageId, (err, img) => {
        if (err) reject(err);
        else resolve(img);
      });
    });
    
    if (!image) {
      return res.status(404).json({ error: '图片不存在' });
    }
    
    // 查找图片关联的项目
    const projectIds = await db.getProjectIdsByImageId(imageId);
    
    if (projectIds.length === 0) {
      // 图片未关联到任何项目，管理员可以访问，普通用户不能
      return res.status(403).json({ error: '该图片未关联到项目，无法访问' });
    }
    
    // 检查是否有任一项目的访问权限
    const sessionId = req.sessionID;
    let hasAccess = false;
    for (const projectId of projectIds) {
      const access = await db.hasProjectAccess(sessionId, projectId);
      if (access) {
        hasAccess = true;
        break;
      }
    }
    
    if (hasAccess) {
      next();
    } else {
      res.status(403).json({ error: '没有访问该图片所属项目的权限，请先输入验证码' });
    }
  } catch (error) {
    console.error('[检查图片项目权限] 错误:', error);
    res.status(500).json({ error: error.message });
  }
};

// ========== 认证相关路由 ==========
// 验证码验证
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const { accessCode } = req.body;
    if (!accessCode || typeof accessCode !== 'string') {
      return res.status(400).json({ error: '验证码不能为空' });
    }
    
    const project = await db.getProjectByAccessCode(accessCode.trim().toUpperCase());
    if (!project) {
      return res.status(404).json({ error: '验证码无效' });
    }
    
    // 检查项目是否锁定（非管理员无法访问锁定的项目）
    if (project.locked && !(req.session && req.session.isAdmin)) {
      return res.status(403).json({ error: '项目已锁定，请联系管理员' });
    }
    
    // 记录session访问权限
    const sessionId = req.sessionID;
    await db.grantProjectAccess(sessionId, project.id);
    
    // 标记 session 已初始化，确保 cookie 被发送（saveUninitialized: false 需要 session 被修改才会保存）
    if (!req.session.accessibleProjectIds) {
      req.session.accessibleProjectIds = [];
    }
    if (!req.session.accessibleProjectIds.includes(project.id)) {
      req.session.accessibleProjectIds.push(project.id);
    }
    
    res.json({
      success: true,
      project: {
        id: project.id,
        name: project.name,
        description: project.description
      }
    });
  } catch (error) {
    console.error('[验证码验证] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 管理员登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    const user = await db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 设置session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = true;
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('[管理员登录] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 修改管理员密码（管理员已登录）
app.post('/api/auth/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: '请填写当前密码、新密码与确认密码' });
    }
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
      return res.status(400).json({ error: '密码格式不正确' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: '两次输入的新密码不一致' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: '新密码至少 8 位' });
    }

    const username = req.session?.username;
    if (!username) {
      return res.status(401).json({ error: '未登录' });
    }

    const user = await db.getUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: '当前密码不正确' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const changed = await db.updateUserPassword(user.id, passwordHash);
    if (!changed) {
      return res.status(500).json({ error: '密码更新失败' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('[修改管理员密码] 错误:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.sessionID;
  req.session.destroy(async (err) => {
    if (err) {
      console.error('[登出] 销毁session失败:', err);
      return res.status(500).json({ error: '登出失败' });
    }
    
    // 清除项目访问权限
    await db.clearSessionAccess(sessionId);
    res.json({ success: true });
  });
});

// 检查当前登录状态
app.get('/api/auth/check', (req, res) => {
  if (req.session && req.session.userId) {
    // 管理员登录
    res.json({
      authenticated: true,
      isAdmin: req.session.isAdmin || false,
      user: {
        id: req.session.userId,
        username: req.session.username
      }
    });
  } else if (req.session && req.session.accessibleProjectIds && req.session.accessibleProjectIds.length > 0) {
    // 普通用户通过验证码进入
    res.json({
      authenticated: true,
      isAdmin: false,
      accessibleProjectIds: req.session.accessibleProjectIds
    });
  } else {
    res.json({ authenticated: false });
  }
});

// 获取当前session可访问的项目列表
app.get('/api/auth/accessible-projects', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    const projects = await db.getAccessibleProjects(sessionId);
    // 将 SQLite 的 INTEGER (0/1) 转换为布尔值
    const formattedProjects = projects.map(p => ({
      ...p,
      locked: p.locked === 1 || p.locked === true
    }));
    res.json(formattedProjects);
  } catch (error) {
    console.error('[获取可访问项目] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== 管理员专用路由 ==========
// 获取所有项目（管理员）
app.get('/api/admin/projects', requireAdmin, async (req, res) => {
  try {
    const projects = await db.getAllProjects();
    // 将 SQLite 的 INTEGER (0/1) 转换为布尔值
    const formattedProjects = projects.map(p => ({
      ...p,
      locked: p.locked === 1 || p.locked === true
    }));
    res.json(formattedProjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 创建项目（管理员，自动生成验证码）
app.post('/api/admin/projects', requireAdmin, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }
    
    // 生成唯一验证码
    let accessCode;
    let attempts = 0;
    do {
      accessCode = generateAccessCode();
      const existing = await db.getProjectByAccessCode(accessCode);
      if (!existing) break;
      attempts++;
      if (attempts > 10) {
        return res.status(500).json({ error: '生成验证码失败，请重试' });
      }
    } while (true);
    
    const project = await db.createProject(name.trim(), description || '', accessCode);
    res.json(project);
  } catch (error) {
    console.error('[创建项目] 错误:', error);
    if (error.message && error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ error: '项目名称已存在' });
    } else {
    res.status(500).json({ error: error.message });
    }
  }
});

// 重新生成项目验证码（管理员）
// 锁定/解锁项目
app.post('/api/admin/projects/:id/toggle-lock', requireAdmin, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      return res.status(400).json({ error: '无效的项目ID' });
    }
    
    const project = await db.getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }
    
    // 切换锁定状态
    const newLocked = !project.locked;
    const updatedProject = await db.toggleProjectLock(projectId, newLocked);
    
    // 返回完整的项目信息，确保所有字段都包含，并转换 locked 字段
    const formattedProject = {
      ...updatedProject,
      locked: updatedProject.locked === 1 || updatedProject.locked === true
    };
    
    res.json(formattedProject);
  } catch (error) {
    console.error('[锁定/解锁项目] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/projects/:id/regenerate-code', requireAdmin, async (req, res) => {
  try {
    const projectId = req.params.id;
    
    // 生成唯一验证码
    let accessCode;
    let attempts = 0;
    do {
      accessCode = generateAccessCode();
      const existing = await db.getProjectByAccessCode(accessCode);
      if (!existing || existing.id === parseInt(projectId)) break;
      attempts++;
      if (attempts > 10) {
        return res.status(500).json({ error: '生成验证码失败，请重试' });
      }
    } while (true);
    
    const project = await db.updateProjectAccessCode(projectId, accessCode);
    if (!project) {
      return res.status(404).json({ error: '项目不存在' });
    }
    
    res.json(project);
  } catch (error) {
    console.error('[重新生成验证码] 错误:', error);
    res.status(500).json({ error: error.message });
  }
});

// 路由
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '智能标注系统后端服务运行中' });
});

// 项目管理接口（需要权限检查）
// 获取当前session可访问的项目列表
app.get('/api/projects', async (req, res) => {
  try {
    // 如果是管理员，返回所有项目；否则只返回可访问的项目
    let projects;
    if (req.session && req.session.isAdmin) {
      projects = await db.getAllProjects();
    } else {
      const sessionId = req.sessionID;
      projects = await db.getAccessibleProjects(sessionId);
    }
    // 将 SQLite 的 INTEGER (0/1) 转换为布尔值
    const formattedProjects = projects.map(p => ({
      ...p,
      locked: p.locked === 1 || p.locked === true
    }));
    res.json(formattedProjects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取单个项目（需要权限检查）
app.get('/api/projects/:id', requireProjectAccess, async (req, res) => {
  try {
    const project = await db.getProjectById(req.params.id);
    if (project) {
      // 非管理员不返回验证码
      if (!req.session || !req.session.isAdmin) {
        delete project.access_code;
      }
      res.json(project);
    } else {
      res.status(404).json({ error: '项目不存在' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新项目（需要权限检查，但普通用户只能更新description）
app.put('/api/projects/:id', requireProjectAccess, async (req, res) => {
  try {
    const { name, description } = req.body;
    // 非管理员不能修改项目名称
    if (!req.session || !req.session.isAdmin) {
      const project = await db.getProjectById(req.params.id);
      if (project) {
        const updated = await db.updateProject(req.params.id, project.name, description || project.description);
        res.json(updated);
      } else {
        res.status(404).json({ error: '项目不存在' });
      }
    } else {
    const project = await db.updateProject(req.params.id, name, description);
    res.json(project);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除项目（仅管理员）
app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
  try {
    const projectId = req.params.id;
    db.deleteProjectWithRelated(projectId, (err, changes) => {
      if (err) {
        return res.status(500).json({ error: err.message || '删除项目失败' });
      }
      res.json({ message: '项目及相关数据删除成功', changes });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 项目标注汇总（用于前端显示“已完成AI标注数量/查看预览”）
app.get('/api/projects/:id/annotation-summary', (req, res) => {
  try {
    const projectId = parseInt(req.params.id);
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        message: '无效的项目ID',
      });
    }

    db.getProjectAnnotationSummary(projectId, (err, summary) => {
      if (err) {
        console.error('获取项目标注汇总失败:', err);
        return res.status(500).json({
          success: false,
          message: '获取项目标注汇总失败',
          error: err.message,
        });
      }

      res.json({
        success: true,
        summary,
      });
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取项目标注汇总失败',
      error: error.message,
    });
  }
});

// 文件上传接口（需要项目访问权限）
// 单次上传最多 2000 个文件（图片 + ZIP），前端也会做同样的数量校验
app.post('/api/upload', upload.array('images', 2000), async (req, res) => {
  try {
    const files = req.files;
    const uploadedFiles = [];
    const { projectId } = req.body;
    
    // 权限检查：如果有 projectId，需要检查访问权限
    if (projectId) {
      const sessionId = req.sessionID;
      const hasAccess = await db.hasProjectAccess(sessionId, projectId);
      if (!hasAccess && (!req.session || !req.session.isAdmin)) {
        return res.status(403).json({
          success: false,
          error: '没有访问该项目的权限，请先输入验证码'
        });
      }
    }
    const zipJobs = [];

    // 额外的防御性校验：避免恶意请求一次传太多文件
    const MAX_FILES_PER_UPLOAD = 2000;
    const totalIncoming = Array.isArray(files) ? files.length : 0;

    if (totalIncoming > MAX_FILES_PER_UPLOAD) {
      return res.status(400).json({
        success: false,
        message: `一次性上传的文件过多：当前 ${totalIncoming} 个，单次最多 ${MAX_FILES_PER_UPLOAD} 个`,
      });
    }

    if (!projectId) {
      console.warn('⚠️ /api/upload 调用时未提供 projectId，本次上传的图片不会关联到任何项目');
    }
    
    // 逐个处理：
    // - 图片：直接入库并返回
    // - ZIP：创建 job，后台解压入库，前端通过 jobId 查询进度与结果
    let completed = 0;

    if (totalIncoming === 0) {
      return res.json({ success: true, files: [], zipJobs: [], message: '未选择任何文件' });
    }

    files.forEach((file) => {
      const isZip = (path.extname(file.originalname || '').toLowerCase() === '.zip');

      if (isZip) {
        const jobId = makeJobId();
        uploadJobs.set(jobId, {
          id: jobId,
          status: 'queued',
          message: '等待解压...',
          zipOriginalName: file.originalname,
          total: 0,
          processed: 0,
          files: [],
        });

        zipJobs.push({
          jobId,
          originalName: file.originalname,
        });

        // 如果有项目ID，将ZIP文件移动到项目文件夹
        let finalZipPath = file.path;
        if (projectId) {
          const projectDir = getProjectUploadDir(projectId);
          const zipFilename = path.basename(file.path);
          finalZipPath = path.join(projectDir, zipFilename);
          try {
            fs.renameSync(file.path, finalZipPath);
          } catch (err) {
            console.error('移动ZIP文件到项目文件夹失败:', err);
            // 如果移动失败，使用原路径
            finalZipPath = file.path;
          }
        }

        // 异步解压，不阻塞当前响应
        setTimeout(() => {
          runZipExtractJob({
            jobId,
            zipPath: finalZipPath,
            zipOriginalName: file.originalname,
            projectId,
          });
        }, 50);

        completed++;
        if (completed === totalIncoming) {
          res.json({
            success: true,
            files: uploadedFiles,
            zipJobs,
            message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个（解压中）`,
          });
        }
        return;
      }

      // 处理普通图片文件：移动到项目文件夹
      let finalPath = file.path;
      let finalUrl = `/uploads/${encodeURIComponent(file.filename)}`;
      
      if (projectId) {
        const projectDir = getProjectUploadDir(projectId);
        const finalFilename = path.basename(file.path);
        finalPath = path.join(projectDir, finalFilename);
        try {
          fs.renameSync(file.path, finalPath);
          finalUrl = `/uploads/project_${projectId}/${encodeURIComponent(finalFilename)}`;
        } catch (err) {
          console.error('移动文件到项目文件夹失败:', err);
          // 如果移动失败，使用原路径
          finalPath = file.path;
        }
      }

      const fileInfo = {
        filename: path.basename(finalPath),
        originalName: file.originalname,
        path: finalPath,
        url: finalUrl,
        size: file.size,
        uploadTime: new Date().toISOString()
      };
      
      db.insertImage(fileInfo, (err, imageId) => {
        if (err) {
          console.error('保存图片信息失败:', err);
          completed++;
          if (completed === totalIncoming) {
            res.json({
              success: true,
              files: uploadedFiles,
              zipJobs,
              message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个（部分图片可能保存失败）`
            });
          }
          return;
        }

        // 将数据库返回的自增ID添加到fileInfo中
        fileInfo.id = imageId;

        const finishOne = () => {
          uploadedFiles.push(fileInfo);
          completed++;
          if (completed === totalIncoming) {
            res.json({
              success: true,
              files: uploadedFiles,
              zipJobs,
              message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个`
            });
          }
        };

        if (projectId) {
          db.linkImageToProject(projectId, imageId, (linkErr) => {
            if (linkErr) {
              console.error('关联图片到项目失败:', linkErr);
            }
            finishOne();
          });
        } else {
          finishOne();
        }
      });
    });
  } catch (error) {
    console.error('❌ /api/upload 处理失败:', error);

    // 针对 Multer 错误给出更友好的提示（例如文件过大）
    if (error && error.name === 'MulterError') {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: '上传失败：单个文件过大。当前单个 ZIP 或图片最大支持 3GB，请拆分后再上传。',
        });
      }

      return res.status(400).json({
        success: false,
        message: `上传失败：${error.message || 'Multer 处理文件时出错'}`,
      });
    }

    res.status(500).json({
      success: false,
      message: '文件上传失败',
      error: error.message,
    });
  }
});

// 9D Pose: upload OBJ meshes (per project)
app.post('/api/meshes/upload', meshUpload.array('meshes', 50), async (req, res) => {
  try {
    const projectIdRaw = req.body?.projectId;
    const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
    if (!projectId || Number.isNaN(projectId)) {
      return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
    }

    const baseUploadsDir = path.join(__dirname, 'uploads');
    const projectMeshDir = path.join(baseUploadsDir, `project_${projectId}`, 'meshes');
    if (!fs.existsSync(projectMeshDir)) {
      fs.mkdirSync(projectMeshDir, { recursive: true });
    }

    const filesRaw = (req.files || []);

    const files = [];
    // 每次上传创建一个资源包子目录，确保 OBJ/MTL/贴图在同一个目录下，并保留原始文件名（否则 OBJ 内 mtllib/map_Kd 会 404）
    const packId = `pack_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    const packDir = path.join(projectMeshDir, packId);
    if (!fs.existsSync(packDir)) {
      fs.mkdirSync(packDir, { recursive: true });
    }

    for (const f of filesRaw) {
      // 将文件从根 uploads 目录移动到本次上传的 pack 目录中，并尽量保留原始文件名
      const original = String(f.originalname || f.filename || 'asset').replace(/\\/g, '/').split('/').pop();
      const ext = String(path.extname(original || '')).toLowerCase();
      const base = path
        .basename(original || f.filename, path.extname(original || f.filename))
        .replace(/[^\w.\-() ]+/g, '_')
        .trim();
      const finalName = `${base || 'asset'}${ext || ''}`;
      const finalPath = path.join(packDir, finalName);
      try {
        fs.renameSync(f.path, finalPath);
      } catch (moveErr) {
        console.error('移动 Mesh 文件到项目目录失败，仍使用原路径:', moveErr);
      }

      const rel = path.relative(baseUploadsDir, finalPath).replace(/\\/g, '/');
      const url = `/uploads/${rel
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/')}`;

      // 只对 .obj 入库（.mtl/贴图属于 OBJ 的配套资源，落盘即可）
      if (ext === '.obj') {
        const meshRecord = {
          projectId,
          filename: finalName,
          originalName: original,
          path: finalPath,
          size: f.size,
          uploadTime: new Date().toISOString(),
        };

        try {
          await new Promise((resolve, reject) => {
            db.insertMesh(meshRecord, (err, meshId) => {
              if (err) return reject(err);
              files.push({
                id: meshId,
                filename: finalName,
                originalName: original,
                size: f.size,
                url,
              });
              resolve();
            });
          });
        } catch (e) {
          console.error('插入 Mesh 记录失败:', e);
          files.push({
            filename: finalName,
            originalName: original,
            size: f.size,
            url,
          });
        }
      }
    }

    return res.json({ success: true, files });
  } catch (error) {
    console.error('❌ /api/meshes/upload 处理失败:', error);
    return res.status(500).json({ success: false, message: error?.message || 'Mesh 上传失败' });
  }
});

// 获取某个项目下的所有 Mesh 记录
app.get('/api/meshes', async (req, res) => {
  try {
    const projectIdRaw = req.query.projectId;
    const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
    if (!projectId || Number.isNaN(projectId)) {
      return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
    }

    db.getMeshesByProjectId(projectId, (err, rows) => {
      if (err) {
        console.error('查询 Mesh 列表失败:', err);
        return res.status(500).json({ success: false, message: '查询 Mesh 列表失败' });
      }

      const meshes = (rows || []).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        filename: row.filename,
        originalName: row.original_name,
        size: row.file_size,
        uploadTime: row.upload_time,
        url: buildImageUrl(row.file_path, row.filename),
        // 资源目录 & 目录内文件列表（用于兼容旧数据：OBJ 引用的 mtl/贴图文件名可能与落盘名不一致）
        assetDirUrl: buildUploadsDirUrl(path.dirname(row.file_path || '')),
        assets: (() => {
          try {
            const dir = path.dirname(row.file_path || '');
            if (!dir || !fs.existsSync(dir)) return [];
            const names = fs.readdirSync(dir).filter((n) => typeof n === 'string');
            // 只返回常见 mesh 资源，避免暴露无关文件
            return names.filter((n) => /\.(mtl|png|jpg|jpeg|webp|bmp|tga|gif|obj)$/i.test(n));
          } catch (e) {
            return [];
          }
        })(),
      }));

      return res.json({ success: true, meshes });
    });
  } catch (error) {
    console.error('❌ GET /api/meshes 处理失败:', error);
    return res.status(500).json({ success: false, message: '获取 Mesh 列表失败' });
  }
});

// 9D Pose: 上传深度图 / 深度原始数据
app.post('/api/depth/upload', depthUpload.array('depthFiles', 2000), async (req, res) => {
  try {
    const projectIdRaw = req.body?.projectId;
    const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
    if (!projectId || Number.isNaN(projectId)) {
      return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
    }

    const baseUploadsDir = path.join(__dirname, 'uploads');
    const projectDepthDir = path.join(baseUploadsDir, `project_${projectId}`, 'depth');
    if (!fs.existsSync(projectDepthDir)) {
      fs.mkdirSync(projectDepthDir, { recursive: true });
    }

    // 预加载该项目下的所有图片，用于按 original_name 绑定 image_id
    const projectImages = await new Promise((resolve, reject) => {
      db.getImagesByProjectId(projectId, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    // 预构建项目中所有 RGB 图片的 key -> imageId 映射
    const imageKeyMap = new Map();
    projectImages.forEach((img) => {
      const key = normalizeDepthKey(img.original_name || img.filename);
      if (!key) return;
      if (!imageKeyMap.has(key)) {
        imageKeyMap.set(key, img.id);
      }
    });

    const findImageIdForDepth = (origName) => {
      const key = normalizeDepthKey(origName);
      if (!key) return null;
      return imageKeyMap.get(key) || null;
    };

    const filesRaw = (req.files || []);
    if (!filesRaw || filesRaw.length === 0) {
      return res.json({ success: true, files: [] });
    }

    // ===== 强校验命名：本次上传的所有深度文件必须能匹配到某张 RGB 图片 =====
    // 约定格式（key 必须完全一致）：
    // - rgb_<key>.<ext>     （RGB 图片来自 2D 模块上传，original_name 需符合此格式）
    // - depth_<key>.png     （深度可视化图）
    // - depth_raw_<key>.npy （深度原始数据）
    //
    // 示例：
    // - rgb_head_0.png
    // - depth_head_0.png
    // - depth_raw_head_0.npy
    const unmatched = [];
    const resolvedImageIds = new Map(); // filename -> imageId
    for (const f of filesRaw) {
      const imageId = findImageIdForDepth(f.originalname);
      if (!imageId) {
        unmatched.push(f.originalname);
      } else {
        resolvedImageIds.set(f.filename, imageId);
      }
    }

    if (unmatched.length > 0) {
      // 清理本次上传的临时文件（仍在 uploads 根目录）
      for (const f of filesRaw) {
        try {
          if (f?.path && fs.existsSync(f.path)) {
            fs.unlinkSync(f.path);
          }
        } catch (e) {
          // 忽略清理失败
        }
      }

      return res.status(400).json({
        success: false,
        message:
          `深度数据上传失败：存在未匹配到 RGB 的文件（请检查命名格式）。\n\n` +
          `命名要求（key 必须一致）：\n` +
          `- rgb_<key>.<ext>\n` +
          `- depth_<key>.png\n` +
          `- depth_raw_<key>.npy\n\n` +
          `未匹配文件：\n- ${unmatched.join('\n- ')}`,
      });
    }

    const files = [];
    for (const f of filesRaw) {
      // 移动到项目 depth 目录
      const finalPath = path.join(projectDepthDir, f.filename);
      try {
        fs.renameSync(f.path, finalPath);
      } catch (moveErr) {
        console.error('移动 Depth 文件到项目目录失败:', moveErr);
        return res.status(500).json({ success: false, message: '移动深度文件到项目目录失败' });
      }

      const rel = path.relative(baseUploadsDir, finalPath).replace(/\\/g, '/');
      const url = `/uploads/${rel
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/')}`;

      // 简单从文件名推断 role / modality
      const nameLower = (f.originalname || '').toLowerCase();
      let role = null;
      if (nameLower.includes('left')) role = 'left';
      else if (nameLower.includes('right')) role = 'right';
      else if (nameLower.includes('head')) role = 'head';

      const ext = String(path.extname(f.originalname || '')).toLowerCase();
      let modality = null;
      if (ext === '.png' || ext === '.tif' || ext === '.tiff') modality = 'depth_png';
      else if (ext === '.npy') modality = 'depth_raw';

      const depthRecord = {
        projectId,
        imageId: resolvedImageIds.get(f.filename) || null,
        role,
        modality,
        filename: f.filename,
        originalName: f.originalname,
        path: finalPath,
        size: f.size,
        uploadTime: new Date().toISOString(),
      };

      const depthId = await new Promise((resolve, reject) => {
        db.insertDepthMap(depthRecord, (err, id) => {
          if (err) return reject(err);
          resolve(id);
        });
      });

      files.push({
        id: depthId,
        filename: f.filename,
        originalName: f.originalname,
        size: f.size,
        url,
        role,
        modality,
        imageId: depthRecord.imageId,
      });
    }

    return res.json({ success: true, files });
  } catch (error) {
    console.error('❌ /api/depth/upload 处理失败:', error);
    return res.status(500).json({ success: false, message: error?.message || '深度数据上传失败' });
  }
});

// 获取某个项目下的所有深度数据记录
app.get('/api/depth', async (req, res) => {
  try {
    const projectIdRaw = req.query.projectId;
    const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
    if (!projectId || Number.isNaN(projectId)) {
      return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
    }

    const imageIdRaw = req.query.imageId;
    const imageId = imageIdRaw != null ? Number(imageIdRaw) : NaN;

    const formatRows = (rows) => {
      return (rows || []).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        imageId: row.image_id,
        role: row.role,
        modality: row.modality,
        filename: row.filename,
        originalName: row.original_name,
        size: row.file_size,
        uploadTime: row.upload_time,
        url: buildImageUrl(row.file_path, row.filename),
      }));
    };

    const handler = (err, rows) => {
      if (err) {
        console.error('查询 Depth 列表失败:', err);
        return res.status(500).json({ success: false, message: '查询 Depth 列表失败' });
      }
      return res.json({ success: true, depth: formatRows(rows) });
    };

    if (imageId && !Number.isNaN(imageId)) {
      db.getDepthMapsByImageId(projectId, imageId, handler);
    } else {
      db.getDepthMapsByProjectId(projectId, handler);
    }
  } catch (error) {
    console.error('❌ GET /api/depth 处理失败:', error);
    return res.status(500).json({ success: false, message: '获取 Depth 列表失败' });
  }
});

// 查询 ZIP 解压进度/结果
app.get('/api/upload-jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = uploadJobs.get(jobId);
  if (!job) {
    return res.status(404).json({
      success: false,
      message: 'job 不存在或已过期',
    });
  }

  const total = job.total || 0;
  const processed = job.processed || 0;
  const progress = total > 0 ? Math.round((processed / total) * 100) : (job.status === 'completed' ? 100 : 0);

  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      message: job.message,
      zipOriginalName: job.zipOriginalName,
      total,
      processed,
      progress,
      // completed 时返回 files，前端用来加入“已上传图片”
      files: job.status === 'completed' ? job.files : [],
      error: job.status === 'error' ? job.error : null,
    }
  });
});

// Grounded SAM2 服务健康检查
async function checkGroundedSAM2Health(apiUrl) {
  try {
    // 尝试访问健康检查端点或根路径
    const healthUrl = apiUrl.replace('/api/auto-label', '/health').replace('/api/auto-label', '');
    const response = await axios.get(healthUrl, { timeout: 5000 });
    return { available: true, status: response.status };
  } catch (error) {
    // 如果健康检查失败，尝试访问主端点（HEAD请求）
    try {
      const baseUrl = apiUrl.replace('/api/auto-label', '');
      await axios.head(baseUrl, { timeout: 5000 });
      return { available: true, status: 200 };
    } catch (headError) {
      return { 
        available: false, 
        error: error.message || headError.message,
        code: error.code || headError.code
      };
    }
  }
}

// 提取标注处理逻辑为独立函数（供队列管理器调用）
async function processAnnotationTask(imageId, modelParams, req) {
  const { imageId: imgId, modelParams: params } = { imageId, modelParams };
  
  console.log(
    `[AI标注] 开始处理图片ID: ${imgId}, modelParams: ${
      params ? JSON.stringify(params) : '默认'
    }`
  );
  
  // 获取图片信息
  const image = await new Promise((resolve, reject) => {
    db.getImageById(imgId, (err, img) => {
      if (err) reject(err);
      else resolve(img);
    });
  });
  
  if (!image) {
    throw new Error(`未找到ID为 ${imgId} 的图片`);
  }
  
  let imagePath = image.file_path;
  const imageUrlPath = buildImageUrl(image.file_path, image.filename);
  const imageUrl = `http://localhost:3001${imageUrlPath}`;
  
  console.log(`[AI标注] 图片路径: ${imagePath}, URL: ${imageUrl}`);
  console.log(`[AI标注] 检查文件是否存在...`);
  
  // 检查文件是否存在，如果不存在则尝试备用路径
  if (!fs.existsSync(imagePath)) {
    console.warn(`[AI标注] ⚠️ 数据库中的路径不存在: ${imagePath}`);
    const uploadDir = path.join(__dirname, 'uploads');
    const alternativePath = path.join(uploadDir, image.filename);
    console.log(`[AI标注] 尝试备用路径: ${alternativePath}`);
    
    if (fs.existsSync(alternativePath)) {
      console.log(`[AI标注] ✅ 备用路径存在，使用备用路径`);
      imagePath = alternativePath;
    } else {
      console.error(`[AI标注] ❌ 备用路径也不存在`);
      throw new Error(`图片文件路径不存在: ${image.file_path}`);
    }
  } else {
    console.log(`[AI标注] ✅ 文件存在，继续处理...`);
  }
  
  const GROUNDED_SAM2_API_URL = process.env.GROUNDED_SAM2_API_URL || 'http://localhost:7860/api/auto-label';
  
  const healthCheck = await checkGroundedSAM2Health(GROUNDED_SAM2_API_URL);
  if (!healthCheck.available) {
    console.warn(`[AI标注] Grounded SAM2服务健康检查失败: ${healthCheck.error} (${healthCheck.code})`);
  }
  
  try {
    console.log(`[AI标注] 调用Grounded SAM2 API: ${GROUNDED_SAM2_API_URL}`);
    
    const formData = new FormData();
    const imageStream = fs.createReadStream(imagePath);
    formData.append('image', imageStream, path.basename(imagePath));

    if (params && typeof params === 'object') {
      if (typeof params.maxPolygonPoints === 'number') {
        formData.append('max_polygon_points', String(params.maxPolygonPoints));
      }
      if (typeof params.sam2PointsPerSide === 'number') {
        formData.append('sam2_points_per_side', String(params.sam2PointsPerSide));
      }
      if (typeof params.sam2PredIouThresh === 'number') {
        formData.append('sam2_pred_iou_thresh', String(params.sam2PredIouThresh));
      }
      if (typeof params.sam2StabilityScoreThresh === 'number') {
        formData.append('sam2_stability_score_thresh', String(params.sam2StabilityScoreThresh));
      }
      if (typeof params.sam2BoxNmsThresh === 'number') {
        formData.append('sam2_box_nms_thresh', String(params.sam2BoxNmsThresh));
      }
      if (typeof params.sam2MinMaskRegionArea === 'number') {
        formData.append('sam2_min_mask_region_area', String(params.sam2MinMaskRegionArea));
      }
    }
    
    const samResponse = await axios.post(GROUNDED_SAM2_API_URL, formData, {
      headers: {
        ...formData.getHeaders(),
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    
    const samData = samResponse.data;
    const annotations = {
      masks: [],
      boundingBoxes: []
    };
    
    if (samData.masks || samData.segments) {
      const masksArr = samData.masks || [];
      const segmentsArr = samData.segments || [];
      
      masksArr.forEach((m, index) => {
        const points = m.points || m.contour || [];
        if (!points || points.length === 0) return;
        annotations.masks.push({
          id: m.id ? `mask-${imgId}-${m.id}` : `mask-${imgId}-${index}`,
          points: Array.isArray(points) ? points.flat() : [],
          label: m.label || m.class || 'object',
        });
      });

      segmentsArr.forEach((seg, index) => {
        const bbox = seg.bbox || {
          x: seg.x,
          y: seg.y,
          width: seg.width,
          height: seg.height,
        };
        if (!bbox) return;
        const x1 = bbox.x ?? bbox[0] ?? 0;
        const y1 = bbox.y ?? bbox[1] ?? 0;
        const x2 = bbox.width != null ? x1 + bbox.width : (bbox[2] ?? x1);
        const y2 = bbox.height != null ? y1 + bbox.height : (bbox[3] ?? y1);

        annotations.boundingBoxes.push({
          id: seg.id ? `bbox-${imgId}-${seg.id}` : `bbox-${imgId}-${index}`,
          x: x1,
          y: y1,
          width: x2 - x1,
          height: y2 - y1,
          label: seg.label || seg.class || 'object',
        });
      });
    } else if (samData.annotations) {
      const segments = Array.isArray(samData.annotations) ? samData.annotations : [samData.annotations];
      segments.forEach((segment, index) => {
        if (segment.mask || segment.points) {
          const points = segment.mask || segment.points || [];
          annotations.masks.push({
            id: `mask-${imgId}-${index}`,
            points: points.flat(),
            label: segment.label || segment.class || 'object',
          });
        }
        if (segment.bbox || segment.bounding_box) {
          const bbox = segment.bbox || segment.bounding_box;
          annotations.boundingBoxes.push({
            id: `bbox-${imgId}-${index}`,
            x: bbox.x || bbox[0] || 0,
            y: bbox.y || bbox[1] || 0,
            width: bbox.width || (bbox[2] - bbox[0]) || 0,
            height: bbox.height || (bbox[3] - bbox[1]) || 0,
            label: segment.label || segment.class || 'object',
          });
        }
      });
    }
    
    console.log(`[AI标注] 标注统计: ${annotations.masks.length} 个masks, ${annotations.boundingBoxes.length} 个boundingBoxes`);
    
    return {
      success: true,
      annotations: annotations,
      message: `自动标注完成，检测到 ${annotations.masks.length + annotations.boundingBoxes.length} 个对象`
    };
    
  } catch (samError) {
    // axios 错误增强：把上游 status/data 打出来，避免前端只看到 500 “报大错”
    const isAxiosError = samError && (samError.isAxiosError || samError.config || samError.response);
    if (isAxiosError && samError.response) {
      const upstreamStatus = samError.response.status;
      let upstreamData = samError.response.data;
      try {
        if (typeof upstreamData !== 'string') upstreamData = JSON.stringify(upstreamData);
      } catch (_) {
        upstreamData = String(upstreamData);
      }
      // 防止日志爆炸
      const truncated = upstreamData && upstreamData.length > 2000 ? `${upstreamData.slice(0, 2000)}...(truncated)` : upstreamData;
      console.error(`[AI标注] Grounded SAM2 上游返回非 2xx: status=${upstreamStatus}, data=${truncated}`);
      throw new Error(`Grounded SAM2 API 调用失败: status=${upstreamStatus}, data=${truncated || '(empty)'}`);
    }

    if (samError && (samError.code === 'ECONNREFUSED' || samError.code === 'ETIMEDOUT' || samError.code === 'ENOTFOUND')) {
      throw new Error(`Grounded SAM2 服务不可用: ${samError.message}`);
    }

    const msg = samError && samError.message ? samError.message : String(samError);
    throw new Error(`Grounded SAM2 调用异常: ${msg}`);
  }
}

// 自动标注接口 - 集成Grounded SAM2（带并发控制和排队）
app.post('/api/annotate/auto', async (req, res) => {
  try {
    const { imageId, modelParams } = req.body;
    
    // 检查用户是否为管理员
    const isAdmin = req.session && req.session.isAdmin === true;
    
    // 添加任务到队列
    const { taskId, immediate, queuePosition } = await annotationQueue.addTask(
      imageId,
      modelParams,
      req,
      res,
      isAdmin
    );

    // 如果任务需要排队
    if (!immediate) {
      return res.status(429).json({
        success: false,
        message: '服务器当前负载较高，您的任务已加入队列',
        error: 'SERVER_OVERLOAD',
        taskId,
        queuePosition,
        maxConcurrent: MAX_CONCURRENT_TASKS,
        currentRunning: annotationQueue.getRunningTaskCount(),
        estimatedWaitTime: queuePosition * 30 // 估算等待时间（秒），假设每个任务30秒
      });
    }

    // 立即执行任务
    try {
      const result = await processAnnotationTask(imageId, modelParams, req);
      annotationQueue.completeTask(taskId);
      res.json(result);
    } catch (error) {
      annotationQueue.completeTask(taskId);
      throw error;
    }
    
  } catch (error) {
    console.error('[AI标注] ========== 处理失败 ==========');
    console.error('[AI标注] 错误类型:', error.constructor.name);
    console.error('[AI标注] 错误消息:', error.message);
    console.error('[AI标注] 错误堆栈:', error.stack);
    console.error('[AI标注] =============================');
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: '自动标注失败',
        error: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
});

// 获取任务队列状态（可选，用于前端轮询）
app.get('/api/annotate/queue-status', (req, res) => {
  const status = annotationQueue.getStatus();
  res.json(status);
});

// 保存标注数据（需要图片所属项目的访问权限）
app.post('/api/annotations/:imageId', requireImageProjectAccess, (req, res) => {
  try {
    const { imageId } = req.params;
    const annotationData = {
      imageId,
      ...req.body
    };
    
    db.saveAnnotation(annotationData, (err, annotationId) => {
      if (err) {
        console.error('保存标注失败:', err);
        return res.status(500).json({
          success: false,
          message: '保存标注失败',
          error: err.message
        });
      }
      
      res.json({
        success: true,
        annotationId,
        message: '标注保存成功'
      });
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '保存标注失败',
      error: error.message
    });
  }
});

// 更新标注数据
app.put('/api/annotations/:imageId', (req, res) => {
  try {
    const { imageId } = req.params;
    const annotationData = {
      imageId,
      ...req.body
    };
    
    db.updateAnnotation(annotationData, (err, changes) => {
      if (err) {
        console.error('更新标注失败:', err);
        return res.status(500).json({
          success: false,
          message: '更新标注失败',
          error: err.message
        });
      }
      
      res.json({
        success: true,
        changes,
        message: '标注更新成功'
      });
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '更新标注失败',
      error: error.message
    });
  }
});

// 获取图像列表
app.get('/api/images', async (req, res) => {
  try {
    const { projectId } = req.query;
    
    // 权限检查：如果有 projectId，需要检查访问权限
    if (projectId) {
      const sessionId = req.sessionID;
      const hasAccess = await db.hasProjectAccess(sessionId, projectId);
      if (!hasAccess && (!req.session || !req.session.isAdmin)) {
        return res.status(403).json({
          success: false,
          error: '没有访问该项目的权限，请先输入验证码'
        });
      }
    } else {
      // 没有 projectId，只允许管理员查看所有图片
      if (!req.session || !req.session.isAdmin) {
        return res.status(403).json({
          success: false,
          error: '需要指定项目ID或管理员权限'
        });
      }
    }

    const handleResult = (err, images) => {
      if (err) {
        console.error('获取图片列表失败:', err);
        return res.status(500).json({
          success: false,
          message: '获取图像列表失败',
          error: err.message
        });
      }
      
      // 转换数据格式以匹配前端期望
      const formattedImages = images.map(img => ({
        id: img.id,
        filename: img.filename,
        originalName: img.original_name,
        url: buildImageUrl(img.file_path, img.filename),
        size: img.file_size,
        width: img.width,
        height: img.height,
        uploadTime: img.upload_time
      }));
      
      res.json({ success: true, images: formattedImages });
    };

    if (projectId) {
      db.getImagesByProjectId(projectId, handleResult);
    } else {
      db.getAllImages(handleResult);
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取图像列表失败',
      error: error.message
    });
  }
});

// 删除图像
app.delete('/api/images/:id', (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
    console.log(`[DELETE /api/images/${imageId}] 开始删除图片，ID: ${imageId}`);

    if (isNaN(imageId)) {
      console.error(`[DELETE /api/images/${req.params.id}] 无效的图片ID`);
      return res.status(400).json({
        success: false,
        message: '无效的图片ID',
        error: 'ID必须是数字'
      });
    }

    // 先获取图片信息，以便删除物理文件
    db.getImageById(imageId, (err, image) => {
      if (err) {
        console.error(`[DELETE /api/images/${imageId}] 查询图片信息失败:`, err);
        return res.status(500).json({
          success: false,
          message: '查询图片信息失败',
          error: err.message
        });
      }

      if (!image) {
        console.warn(`[DELETE /api/images/${imageId}] 图片不存在`);
        return res.status(404).json({
          success: false,
          message: '图片不存在'
        });
      }

      console.log(`[DELETE /api/images/${imageId}] 找到图片:`, {
        id: image.id,
        filename: image.filename,
        file_path: image.file_path
      });

      // 删除数据库记录
      db.deleteImage(imageId, (deleteErr, changes) => {
        if (deleteErr) {
          console.error(`[DELETE /api/images/${imageId}] 删除数据库记录失败:`, deleteErr);
          return res.status(500).json({
            success: false,
            message: '删除数据库记录失败',
            error: deleteErr.message
          });
        }

        if (changes === 0) {
          console.warn(`[DELETE /api/images/${imageId}] 数据库中没有找到要删除的记录`);
          return res.status(404).json({
            success: false,
            message: '图片不存在'
          });
        }

        console.log(`[DELETE /api/images/${imageId}] 数据库记录已删除，影响行数: ${changes}`);

        // 删除物理文件
        if (image.file_path && fs.existsSync(image.file_path)) {
          fs.unlink(image.file_path, (unlinkErr) => {
            if (unlinkErr) {
              console.error(`[DELETE /api/images/${imageId}] 删除物理文件失败:`, unlinkErr);
              // 即使文件删除失败，也返回成功（因为数据库记录已删除）
              console.warn(`[DELETE /api/images/${imageId}] 警告: 数据库记录已删除，但物理文件删除失败`);
            } else {
              console.log(`[DELETE /api/images/${imageId}] 物理文件已删除: ${image.file_path}`);
            }
          });
        } else {
          console.warn(`[DELETE /api/images/${imageId}] 物理文件不存在或路径为空: ${image.file_path}`);
        }

        res.json({
          success: true,
          message: '图片删除成功',
          deletedId: imageId,
          changes: changes
        });
      });
    });
  } catch (error) {
    console.error(`[DELETE /api/images/${req.params.id}] 删除图片异常:`, error);
    res.status(500).json({
      success: false,
      message: '删除图片失败',
      error: error.message
    });
  }
});

// 获取标注数据
app.get('/api/annotations/:imageId', requireImageProjectAccess, (req, res) => {
  try {
    const { imageId } = req.params;
    
    db.getAnnotationByImageId(imageId, (err, annotation) => {
      if (err) {
        console.error('获取标注失败:', err);
        return res.status(500).json({
          success: false,
          message: '获取标注失败',
          error: err.message
        });
      }
      
      res.json({
        success: true,
        annotation: annotation || null
      });
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取标注失败',
      error: error.message
    });
  }
});

// 测试文件访问
app.get('/api/test-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'uploads', filename);
  
  console.log('测试文件访问:', {
    filename,
    filePath,
    exists: fs.existsSync(filePath)
  });
  
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    res.json({
      success: true,
      filename,
      path: filePath,
      size: stats.size,
      created: stats.birthtime
    });
  } else {
    res.status(404).json({
      success: false,
      message: '文件不存在',
      filename,
      searchedPath: filePath
    });
  }
});

// 404 处理（放在所有路由之后）
app.use((req, res) => {
  console.log(`[404] 未找到路由: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: '路由未找到',
    method: req.method,
    path: req.path
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('[服务器错误]', err);
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? err.message : '内部服务器错误'
  });
});

// 初始化默认管理员账号（如果不存在）
async function initializeDefaultAdmin() {
  try {
    const defaultUsername = process.env.ADMIN_USERNAME || 'DaxAdmin';
    const adminUser = await db.getUserByUsername(defaultUsername);
    if (!adminUser) {
      // 默认密码：admin123（生产环境请修改！）
      const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      await db.createUser(defaultUsername, passwordHash);
      console.log(`✅ 已创建默认管理员账号: ${defaultUsername}`);
      console.log('⚠️  默认密码: admin123（请在生产环境中修改！）');
      console.log('⚠️  可通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 设置账号密码');
    } else {
      console.log('✅ 管理员账号已存在');
    }
  } catch (error) {
    console.error('❌ 初始化管理员账号失败:', error);
  }
}

// 启动服务器
app.listen(PORT, async () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`📝 自动标注接口: http://localhost:${PORT}/api/annotate/auto`);
  
  // 初始化默认管理员
  await initializeDefaultAdmin();
});