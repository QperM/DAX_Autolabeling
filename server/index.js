const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

// 自动标注接口
app.post('/api/annotate/auto', async (req, res) => {
  try {
    const { imageId, prompt } = req.body;
    
    // 这里集成SAM3或其他大模型API
    // 模拟返回标注数据
    const mockAnnotations = {
      masks: [
        {
          id: 'mask-1',
          points: [100, 100, 200, 100, 200, 200, 100, 200],
          label: 'object'
        }
      ],
      boundingBoxes: [
        {
          id: 'bbox-1',
          x: 100,
          y: 100,
          width: 100,
          height: 100,
          label: 'object'
        }
      ]
    };
    
    res.json({
      success: true,
      annotations: mockAnnotations,
      message: '自动标注完成'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '自动标注失败',
      error: error.message
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