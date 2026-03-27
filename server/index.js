const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');
const { startServer } = require('./utils/bootstrap');
// routes
const { getProjectUploadDir, buildImageUrl, buildUploadsDirUrl } = require('./utils/uploads');
const { normalizeDepthKey, inferRoleFromFilename } = require('./utils/depthNaming');
const { makeAuthzMiddlewares } = require('./middleware/authz');
const { registerDepthRoutes } = require('./routes/depth');
const { registerAuthRoutes } = require('./routes/auth');
const { registerProjectRoutes } = require('./routes/projects');
const { registerUploadRoutes } = require('./routes/uploads');
const { registerMeshRoutes } = require('./routes/meshes');
const { computeObjBoundingBox } = require('./utils/objBBox');
const { registerAutoAnnotateRoutes } = require('./routes/autoAnnotate');
const { registerAnnotationRoutes } = require('./routes/annotations');
const { registerImageRoutes } = require('./routes/images');
const { registerPoseRoutes } = require('./routes/pose');
const { registerDebugRoutes } = require('./routes/debug');
const { registerProjectSessionRoutes } = require('./routes/projectSession');
const { getUploadsRootDir } = require('./utils/dataPaths');
const { makeProjectSessionGuard } = require('./utils/projectSessionGuard');

const app = express();
const PORT = process.env.PORT || 3001;
// Pose service (Python) for diff-dope or future refiners
const POSE_SERVICE_URL = process.env.POSE_SERVICE_URL || 'http://localhost:7900';
const DEPTH_REPAIR_SERVICE_URL = process.env.DEPTH_REPAIR_SERVICE_URL || 'http://localhost:7870';

// 统一的管理员账号配置（只允许这一个账号登录）
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'DaxAdmin';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// auto annotate queue moved to server/routes/autoAnnotate.js

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
    // 本地 Docker (http://localhost:38080) 下不能使用 secure，否则浏览器不会保存 Cookie
    // 通过环境变量显式控制，默认关闭；将来线上如果有 HTTPS，可以在部署时设置 SESSION_COOKIE_SECURE=true
    secure: process.env.SESSION_COOKIE_SECURE === 'true',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7天
  }
}));

// 静态文件服务
app.use('/uploads', express.static(getUploadsRootDir()));

// 文件上传配置
// 注意：multer 的 destination 在文件解析前执行，req.body 可能还没有值
// 所以我们先保存到临时位置，然后在处理中移动到项目文件夹
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getUploadsRootDir();
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const original = String(file.originalname || 'image');
    const ext = (path.extname(original) || '').toLowerCase() || '.bin';
    const uniqueSuffix = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    cb(null, `__stg_${uniqueSuffix}${ext}`);
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
// mesh upload config moved to server/routes/meshes.js

// Depth upload storage（与 mesh 一样先落盘到 uploads 根目录）
const depthStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getUploadsRootDir();
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
    // 支持深度图、原始深度数据、相机内参
    if (['.png', '.tif', '.tiff'].includes(ext)) return cb(null, true);
    if (ext === '.npy') return cb(null, true);
    if (ext === '.json') return cb(null, true);
    cb(new Error('仅支持深度图 PNG/TIFF、.npy 原始深度数据或 intrinsics_*.json 相机内参'));
  },
});

// upload + zip jobs routes are registered via server/routes/uploads.js

// computeObjBoundingBox moved to server/utils/objBBox.js

// ZIP job helpers moved to server/routes/uploads.js
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
const projectSessionGuard = makeProjectSessionGuard();
const { requireAdmin, requireProjectAccess, requireImageProjectAccess } = makeAuthzMiddlewares({ db, projectSessionGuard });

// ===== Register decoupled routes =====
// depth + cameras
registerDepthRoutes(app, {
  db,
  normalizeDepthKey,
  inferRoleFromFilename,
  buildImageUrl,
  depthRepairServiceUrl: DEPTH_REPAIR_SERVICE_URL,
});

// auth
registerAuthRoutes(app, { db, bcrypt, requireAdmin, DEFAULT_ADMIN_USERNAME, projectSessionGuard });

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '智能标注系统后端服务运行中' });
});

// projects
registerProjectRoutes(app, { db, requireAdmin, requireProjectAccess, generateAccessCode, projectSessionGuard });
registerProjectSessionRoutes(app, { db, projectSessionGuard });

// uploads + zip jobs
registerUploadRoutes(app, { db, upload, getProjectUploadDir });

// meshes
registerMeshRoutes(app, { db, computeObjBoundingBox, buildImageUrl, buildUploadsDirUrl });

// auto annotate + annotations
registerAutoAnnotateRoutes(app, { db, buildImageUrl });
registerAnnotationRoutes(app, { db, requireImageProjectAccess });
registerImageRoutes(app, { db, buildImageUrl, projectSessionGuard });
registerPoseRoutes(app, { db, requireImageProjectAccess, poseServiceUrl: POSE_SERVICE_URL });
registerDebugRoutes(app);

// 9D Pose: 上传深度图 / 深度原始数据
// depth + cameras routes are registered via server/routes/depth.js

// images + pose routes moved to server/routes/images.js and server/routes/pose.js

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

// 启动服务器（集中到 bootstrap.js）
startServer(app, {
  port: PORT,
  defaultAdminUsername: DEFAULT_ADMIN_USERNAME,
  defaultAdminPassword: DEFAULT_ADMIN_PASSWORD,
});