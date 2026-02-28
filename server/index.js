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

// 文件上传接口
app.post('/api/upload', upload.array('images', 10), (req, res) => {
  try {
    const files = req.files;
    const uploadedFiles = [];
    
    // 逐个保存到数据库
    let completed = 0;
    files.forEach((file, index) => {
      const fileInfo = {
        id: `img_${Date.now()}_${Math.random()}`,
        filename: file.filename,
        originalName: file.originalname,
        path: file.path,
        url: `/uploads/${encodeURIComponent(file.filename)}`,
        size: file.size,
        uploadTime: new Date().toISOString()
      };
      
      db.insertImage(fileInfo, (err, lastId) => {
        if (err) {
          console.error('保存图片信息失败:', err);
        } else {
          uploadedFiles.push(fileInfo);
        }
        
        completed++;
        if (completed === files.length) {
          res.json({
            success: true,
            files: uploadedFiles,
            message: `${uploadedFiles.length}个文件上传成功`
          });
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
    db.getAllImages((err, images) => {
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
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取图像列表失败',
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