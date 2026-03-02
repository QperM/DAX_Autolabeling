const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const db = require('./database');

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
app.post('/api/upload', upload.array('images', 10), (req, res) => {
  try {
    const files = req.files;
    const uploadedFiles = [];
    const { projectId } = req.body;

    if (!projectId) {
      console.warn('⚠️ /api/upload 调用时未提供 projectId，本次上传的图片不会关联到任何项目');
    }
    
    // 逐个保存到数据库
    let completed = 0;
    files.forEach((file, index) => {
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
          if (completed === files.length) {
            res.json({
              success: true,
              files: uploadedFiles,
              message: `${uploadedFiles.length}个文件上传成功（部分可能保存失败）`
            });
          }
          return;
        }

        // 检查 imageId 是否有效
        if (!imageId || imageId === 0) {
          console.error('⚠️ 警告: 插入图片后未获取到有效的 ID');
        }

        // 将数据库返回的自增ID添加到fileInfo中
        fileInfo.id = imageId;

        const finishOne = () => {
          uploadedFiles.push(fileInfo);
          completed++;
          if (completed === files.length) {
            res.json({
              success: true,
              files: uploadedFiles,
              message: `${uploadedFiles.length}个文件上传成功`
            });
          }
        };

        // 如果提供了项目ID，则将图片关联到项目
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
    const { imageId, prompt } = req.body;
    
    console.log(`[AI标注] 开始处理图片ID: ${imageId}, prompt: ${prompt || '无'}`);
    
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
      console.log(`[AI标注] 请求参数: imageId=${imageId}, prompt=${prompt || '无'}`);
      
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
      
      // 添加图片URL作为备用参数（某些 API 可能支持）
      // formData.append('image_url', imageUrl);
      
      console.log(`[AI标注] FormData字段: image${prompt ? ', text_prompt' : ''}`);
      
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
      
      // 如果Grounded SAM2返回的是标准格式
      if (samData.masks || samData.segments) {
        const segments = samData.masks || samData.segments || [];
        console.log(`[AI标注] 检测到 ${segments.length} 个标注段`);
        
        segments.forEach((segment, index) => {
          // 处理Mask数据
          if (segment.points || segment.contour) {
            const points = segment.points || segment.contour || [];
            annotations.masks.push({
              id: `mask-${imageId}-${index}`,
              points: points.flat(), // 展平点数组 [x1, y1, x2, y2, ...]
              label: segment.label || segment.class || 'object',
            });
          }
          
          // 处理边界框数据
          if (segment.bbox || (segment.x && segment.y && segment.width && segment.height)) {
            const bbox = segment.bbox || {
              x: segment.x,
              y: segment.y,
              width: segment.width,
              height: segment.height
            };
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
      
      // 如果Grounded SAM2服务不可用，返回模拟数据（用于测试）
      if (samError.code === 'ECONNREFUSED' || samError.code === 'ETIMEDOUT' || samError.code === 'ENOTFOUND') {
        console.warn('[AI标注] Grounded SAM2服务不可用，返回模拟数据用于测试');
        console.warn(`[AI标注] 解决方案:`);
        console.warn(`[AI标注] 1. 确保Grounded SAM2服务正在运行`);
        console.warn(`[AI标注] 2. 检查服务地址是否正确: ${GROUNDED_SAM2_API_URL}`);
        console.warn(`[AI标注] 3. 可以通过环境变量设置: GROUNDED_SAM2_API_URL=http://your-service:port/api/auto-label`);
        
        // 获取图片尺寸（用于生成合理的模拟标注）
        let imgWidth = image.width || 800;
        let imgHeight = image.height || 600;
        if (!imgWidth || !imgHeight) {
          const imageSizeModule = require('image-size');
          const sizeFn = imageSizeModule.imageSize || imageSizeModule;
          try {
            const buffer = fs.readFileSync(imagePath);
            const dimensions = sizeFn(buffer);
            imgWidth = dimensions.width;
            imgHeight = dimensions.height;
            console.log(`[AI标注] 从文件读取图片尺寸: ${imgWidth}x${imgHeight}`);
          } catch (e) {
            console.warn('[AI标注] 无法获取图片尺寸，使用默认值:', e.message);
          }
        } else {
          console.log(`[AI标注] 使用数据库中的图片尺寸: ${imgWidth}x${imgHeight}`);
        }
        
        const mockAnnotations = {
          masks: [
            {
              id: `mask-${imageId}-1`,
              points: [
                imgWidth * 0.2, imgHeight * 0.2,
                imgWidth * 0.4, imgHeight * 0.2,
                imgWidth * 0.4, imgHeight * 0.4,
                imgWidth * 0.2, imgHeight * 0.4
              ],
              label: prompt || 'object'
            }
          ],
          boundingBoxes: [
            {
              id: `bbox-${imageId}-1`,
              x: imgWidth * 0.2,
              y: imgHeight * 0.2,
              width: imgWidth * 0.2,
              height: imgHeight * 0.2,
              label: prompt || 'object'
            }
          ]
        };
        
        res.json({
          success: true,
          annotations: mockAnnotations,
          message: '自动标注完成（使用模拟数据，Grounded SAM2服务未连接）',
          warning: `Grounded SAM2服务不可用: ${samError.message}。请检查服务是否运行在 ${GROUNDED_SAM2_API_URL}`
        });
      } else {
        throw samError;
      }
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