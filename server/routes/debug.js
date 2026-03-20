const express = require('express');
const path = require('path');
const fs = require('fs');

function registerDebugRoutes(app) {
  const router = express.Router();

  // 测试文件访问（开发调试用）
  router.get('/test-file/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '..', 'uploads', filename);

    console.log('测试文件访问:', {
      filename,
      filePath,
      exists: fs.existsSync(filePath),
    });

    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      res.json({
        success: true,
        filename,
        path: filePath,
        size: stats.size,
        created: stats.birthtime,
      });
    } else {
      res.status(404).json({
        success: false,
        message: '文件不存在',
        filename,
        searchedPath: filePath,
      });
    }
  });

  app.use('/api', router);
}

module.exports = { registerDebugRoutes };

