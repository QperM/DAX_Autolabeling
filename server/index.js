const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const db = require('./database');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件配置
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 文件上传配置
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

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB限制
  }
});

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

  const uploadDir = path.join(__dirname, 'uploads');
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);

    // 安全限制：最多处理 500 个文件，最多 600MB 解压后体积（防 zip bomb）
    const MAX_FILES = 500;
    const MAX_TOTAL_UNCOMPRESSED = 600 * 1024 * 1024;

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

      const fileInfo = {
        filename,
        originalName: orig,
        path: outPath,
        url: `/uploads/${encodeURIComponent(filename)}`,
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

// 路由
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: '智能标注系统后端服务运行中' });
});

// 项目管理接口
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await db.getAllProjects();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { name, description } = req.body;
    const project = await db.createProject(name, description);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await db.getProjectById(req.params.id);
    if (project) {
      res.json(project);
    } else {
      res.status(404).json({ error: '项目不存在' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const { name, description } = req.body;
    const project = await db.updateProject(req.params.id, name, description);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
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

// 文件上传接口
app.post('/api/upload', upload.array('images', 500), (req, res) => {
  try {
    const files = req.files;
    const uploadedFiles = [];
    const { projectId } = req.body;
    const zipJobs = [];

    if (!projectId) {
      console.warn('⚠️ /api/upload 调用时未提供 projectId，本次上传的图片不会关联到任何项目');
    }
    
    // 逐个处理：
    // - 图片：直接入库并返回
    // - ZIP：创建 job，后台解压入库，前端通过 jobId 查询进度与结果
    let completed = 0;
    const totalIncoming = files?.length || 0;

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

        // 异步解压，不阻塞当前响应
        setTimeout(() => {
          runZipExtractJob({
            jobId,
            zipPath: file.path,
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

      const fileInfo = {
        filename: file.filename,
        originalName: file.originalname,
        path: file.path,
        url: `/uploads/${encodeURIComponent(file.filename)}`,
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
    res.status(500).json({
      success: false,
      message: '文件上传失败',
      error: error.message
    });
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

// 自动标注接口 - 集成Grounded SAM2
app.post('/api/annotate/auto', async (req, res) => {
  try {
    const { imageId, prompt, modelParams } = req.body;
    
    console.log(
      `[AI标注] 开始处理图片ID: ${imageId}, prompt: ${prompt || '无'}, modelParams: ${
        modelParams ? JSON.stringify(modelParams) : '默认'
      }`
    );
    
    // 获取图片信息
    const image = await new Promise((resolve, reject) => {
      db.getImageById(imageId, (err, img) => {
        if (err) reject(err);
        else resolve(img);
      });
    });
    
    if (!image) {
      return res.status(404).json({
        success: false,
        message: '图片不存在',
        error: `未找到ID为 ${imageId} 的图片`
      });
    }
    
    const imagePath = image.file_path;
    const imageUrl = `http://localhost:3001/uploads/${encodeURIComponent(image.filename)}`;
    
    console.log(`[AI标注] 图片路径: ${imagePath}, URL: ${imageUrl}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(imagePath)) {
      return res.status(404).json({
        success: false,
        message: '图片文件不存在',
        error: `图片文件路径不存在: ${imagePath}`
      });
    }
    
    // 调用Grounded SAM2 API
    // 注意：这里需要配置Grounded SAM2服务的地址
    // 如果Grounded SAM2运行在本地，默认端口可能是7860或其他
    const GROUNDED_SAM2_API_URL = process.env.GROUNDED_SAM2_API_URL || 'http://localhost:7860/api/auto-label';
    
    // 先检查服务是否可用（可选，避免每次都检查）
    const healthCheck = await checkGroundedSAM2Health(GROUNDED_SAM2_API_URL);
    if (!healthCheck.available) {
      console.warn(`[AI标注] Grounded SAM2服务健康检查失败: ${healthCheck.error} (${healthCheck.code})`);
      console.warn(`[AI标注] API地址: ${GROUNDED_SAM2_API_URL}`);
      console.warn(`[AI标注] 提示: 请确保Grounded SAM2服务正在运行，或检查环境变量 GROUNDED_SAM2_API_URL`);
    }
    
    try {
      console.log(`[AI标注] 调用Grounded SAM2 API: ${GROUNDED_SAM2_API_URL}`);
      console.log(
        `[AI标注] 请求参数: imageId=${imageId}, prompt=${prompt || '无'}, modelParams=${
          modelParams ? JSON.stringify(modelParams) : '默认'
        }`
      );
      
      // 读取图片文件并发送到Grounded SAM2
      const formData = new FormData();
      
      // 使用 image 字段名（Grounded SAM2 常用）
      const imageStream = fs.createReadStream(imagePath);
      formData.append('image', imageStream, path.basename(imagePath));
      
      // 如果 API 需要 file 字段，可以取消下面的注释
      // const fileStream = fs.createReadStream(imagePath);
      // formData.append('file', fileStream, path.basename(imagePath));
      
      if (prompt) {
        formData.append('text_prompt', prompt);
        // 某些 API 可能使用 prompt 字段
        // formData.append('prompt', prompt);
      }

      // 模型参数（可选，透传给 Python SAM2 服务）
      if (modelParams && typeof modelParams === 'object') {
        // 选择后端（maskrcnn / yolo_seg / sam2_amg）
        if (typeof modelParams.modelBackend === 'string' && modelParams.modelBackend.trim().length > 0) {
          formData.append('model_backend', String(modelParams.modelBackend));
        }

        if (typeof modelParams.baseScoreThresh === 'number') {
          formData.append('base_score_thresh', String(modelParams.baseScoreThresh));
        }
        if (typeof modelParams.lowerScoreThresh === 'number') {
          formData.append('lower_score_thresh', String(modelParams.lowerScoreThresh));
        }
        if (typeof modelParams.maxDetections === 'number') {
          formData.append('max_detections', String(modelParams.maxDetections));
        }
        if (typeof modelParams.maskThreshold === 'number') {
          formData.append('mask_threshold', String(modelParams.maskThreshold));
        }
        if (typeof modelParams.maxPolygonPoints === 'number') {
          formData.append('max_polygon_points', String(modelParams.maxPolygonPoints));
        }

        // YOLO-Seg 参数
        if (typeof modelParams.yoloConf === 'number') {
          formData.append('yolo_conf', String(modelParams.yoloConf));
        }
        if (typeof modelParams.yoloIou === 'number') {
          formData.append('yolo_iou', String(modelParams.yoloIou));
        }
        if (typeof modelParams.yoloImgSize === 'number') {
          formData.append('yolo_imgsz', String(modelParams.yoloImgSize));
        }
        if (typeof modelParams.yoloMaxDet === 'number') {
          formData.append('yolo_max_det', String(modelParams.yoloMaxDet));
        }

        // SAM2 AMG 参数
        if (typeof modelParams.sam2PointsPerSide === 'number') {
          formData.append('sam2_points_per_side', String(modelParams.sam2PointsPerSide));
        }
        if (typeof modelParams.sam2PredIouThresh === 'number') {
          formData.append('sam2_pred_iou_thresh', String(modelParams.sam2PredIouThresh));
        }
        if (typeof modelParams.sam2StabilityScoreThresh === 'number') {
          formData.append('sam2_stability_score_thresh', String(modelParams.sam2StabilityScoreThresh));
        }
        if (typeof modelParams.sam2BoxNmsThresh === 'number') {
          formData.append('sam2_box_nms_thresh', String(modelParams.sam2BoxNmsThresh));
        }
        if (typeof modelParams.sam2MinMaskRegionArea === 'number') {
          formData.append('sam2_min_mask_region_area', String(modelParams.sam2MinMaskRegionArea));
        }
      }
      
      // 添加图片URL作为备用参数（某些 API 可能支持）
      // formData.append('image_url', imageUrl);
      
      if (modelParams && typeof modelParams === 'object') {
        console.log('[AI标注] FormData 已附加的模型参数字段:');
        console.log(`  - model_backend = ${modelParams.modelBackend || '默认(maskrcnn)'}`);
        console.log(
          `  - 通用参数: base_score_thresh=${modelParams.baseScoreThresh ?? '默认'}, ` +
          `lower_score_thresh=${modelParams.lowerScoreThresh ?? '默认'}, ` +
          `max_detections=${modelParams.maxDetections ?? '默认'}, ` +
          `mask_threshold=${modelParams.maskThreshold ?? '默认'}, ` +
          `max_polygon_points=${modelParams.maxPolygonPoints ?? '默认'}`
        );
        console.log(
          '  - YOLO-Seg 参数: ' +
          `yolo_conf=${modelParams.yoloConf ?? '默认'}, ` +
          `yolo_iou=${modelParams.yoloIou ?? '默认'}, ` +
          `yolo_imgsz=${modelParams.yoloImgSize ?? '默认'}, ` +
          `yolo_max_det=${modelParams.yoloMaxDet ?? '默认'}`
        );
        console.log(
          '  - SAM2 AMG 参数: ' +
          `sam2_points_per_side=${modelParams.sam2PointsPerSide ?? '默认'}, ` +
          `sam2_pred_iou_thresh=${modelParams.sam2PredIouThresh ?? '默认'}, ` +
          `sam2_stability_score_thresh=${modelParams.sam2StabilityScoreThresh ?? '默认'}, ` +
          `sam2_box_nms_thresh=${modelParams.sam2BoxNmsThresh ?? '默认'}, ` +
          `sam2_min_mask_region_area=${modelParams.sam2MinMaskRegionArea ?? '默认'}`
        );
      } else {
        console.log('[AI标注] FormData字段: image' + (prompt ? ', text_prompt' : '') + '（使用后端默认参数）');
      }
      
      // 调用Grounded SAM2 API
      const samResponse = await axios.post(GROUNDED_SAM2_API_URL, formData, {
        headers: {
          ...formData.getHeaders(),
          // 某些API可能需要特定的Content-Type
          // 'Content-Type': 'multipart/form-data'
        },
        timeout: 120000, // 120秒超时（AI处理可能需要更长时间）
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      
      console.log(`[AI标注] Grounded SAM2响应状态: ${samResponse.status}`);
      console.log(`[AI标注] Grounded SAM2响应头:`, JSON.stringify(samResponse.headers, null, 2));
      console.log(`[AI标注] Grounded SAM2响应数据:`, JSON.stringify(samResponse.data, null, 2));
      
      // 解析Grounded SAM2的响应并转换为我们的格式
      const samData = samResponse.data;
      
      // 转换标注数据格式
      const annotations = {
        masks: [],
        boundingBoxes: []
      };
      
      // 如果Grounded SAM2返回的是标准格式（masks + segments）
      if (samData.masks || samData.segments) {
        const masksArr = samData.masks || [];
        const segmentsArr = samData.segments || [];
        console.log(`[AI标注] 检测到 masks=${masksArr.length}, segments=${segmentsArr.length}`);

        // 处理 masks（多边形点）
        masksArr.forEach((m, index) => {
          const points = m.points || m.contour || [];
          if (!points || points.length === 0) return;
          annotations.masks.push({
            id: m.id ? `mask-${imageId}-${m.id}` : `mask-${imageId}-${index}`,
            points: Array.isArray(points) ? points.flat() : [],
            label: m.label || m.class || 'object',
          });
        });

        // 处理 segments（bbox + points）
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
            id: seg.id ? `bbox-${imageId}-${seg.id}` : `bbox-${imageId}-${index}`,
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1,
            label: seg.label || seg.class || 'object',
          });
        });
      } else if (samData.annotations) {
        // 如果返回的是 annotations 字段
        console.log(`[AI标注] 检测到 annotations 字段格式`);
        const segments = Array.isArray(samData.annotations) ? samData.annotations : [samData.annotations];
        segments.forEach((segment, index) => {
          if (segment.mask || segment.points) {
            const points = segment.mask || segment.points || [];
            annotations.masks.push({
              id: `mask-${imageId}-${index}`,
              points: points.flat(),
              label: segment.label || segment.class || 'object',
            });
          }
          if (segment.bbox || segment.bounding_box) {
            const bbox = segment.bbox || segment.bounding_box;
            annotations.boundingBoxes.push({
              id: `bbox-${imageId}-${index}`,
              x: bbox.x || bbox[0] || 0,
              y: bbox.y || bbox[1] || 0,
              width: bbox.width || (bbox[2] - bbox[0]) || 0,
              height: bbox.height || (bbox[3] - bbox[1]) || 0,
              label: segment.label || segment.class || 'object',
            });
          }
        });
      } else {
        // 如果返回格式不同，尝试适配
        console.warn('[AI标注] Grounded SAM2返回格式未识别，尝试直接使用原始数据');
        console.warn('[AI标注] 原始响应结构:', Object.keys(samData));
        // 可以在这里添加更多格式适配逻辑
      }
      
      console.log(`[AI标注] 转换后的标注数据:`, JSON.stringify(annotations, null, 2));
      console.log(`[AI标注] 标注统计: ${annotations.masks.length} 个masks, ${annotations.boundingBoxes.length} 个boundingBoxes`);
      
      res.json({
        success: true,
        annotations: annotations,
        message: `自动标注完成，检测到 ${annotations.masks.length + annotations.boundingBoxes.length} 个对象`
      });
      
    } catch (samError) {
      // 详细的错误日志
      console.error('[AI标注] ========== Grounded SAM2 API调用失败 ==========');
      console.error('[AI标注] 错误类型:', samError.constructor.name);
      console.error('[AI标注] 错误消息:', samError.message);
      console.error('[AI标注] 错误代码:', samError.code);
      console.error('[AI标注] 错误状态码:', samError.response?.status);
      console.error('[AI标注] 错误响应数据:', samError.response?.data);
      console.error('[AI标注] 请求URL:', GROUNDED_SAM2_API_URL);
      console.error('[AI标注] 请求配置:', {
        timeout: samError.config?.timeout,
        method: samError.config?.method,
        headers: samError.config?.headers
      });
      if (samError.stack) {
        console.error('[AI标注] 错误堆栈:', samError.stack);
      }
      console.error('[AI标注] ============================================');
      
      // Grounded SAM2 服务不可用：直接视为失败（不再返回模拟数据，避免前端“乱画”）
      if (samError.code === 'ECONNREFUSED' || samError.code === 'ETIMEDOUT' || samError.code === 'ENOTFOUND') {
        console.warn('[AI标注] Grounded SAM2服务不可用，已按失败处理（不返回模拟数据）');
        console.warn(`[AI标注] 解决方案:`);
        console.warn(`[AI标注] 1. 确保Grounded SAM2服务正在运行`);
        console.warn(`[AI标注] 2. 检查服务地址是否正确: ${GROUNDED_SAM2_API_URL}`);
        console.warn(`[AI标注] 3. 可以通过环境变量设置: GROUNDED_SAM2_API_URL=http://your-service:port/api/auto-label`);

        return res.status(502).json({
          success: false,
          message: '自动标注失败：Grounded SAM2 服务不可用',
          error: samError.message,
          serviceUrl: GROUNDED_SAM2_API_URL,
          code: samError.code
        });
      }

      throw samError;
    }
    
  } catch (error) {
    console.error('[AI标注] ========== 处理失败 ==========');
    console.error('[AI标注] 错误类型:', error.constructor.name);
    console.error('[AI标注] 错误消息:', error.message);
    console.error('[AI标注] 错误堆栈:', error.stack);
    console.error('[AI标注] =============================');
    
    res.status(500).json({
      success: false,
      message: '自动标注失败',
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// 保存标注数据
app.post('/api/annotations/:imageId', (req, res) => {
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
app.get('/api/images', (req, res) => {
  try {
    const { projectId } = req.query;

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
        url: `/uploads/${encodeURIComponent(img.filename)}`,
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
app.get('/api/annotations/:imageId', (req, res) => {
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

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
});