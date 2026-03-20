const express = require('express');

function registerAnnotationRoutes(app, { db, requireImageProjectAccess }) {
  const router = express.Router();

  // 保存标注数据（需要图片所属项目的访问权限）
  router.post('/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const annotationData = {
        imageId,
        ...req.body,
      };

      db.saveAnnotation(annotationData, (err, annotationId) => {
        if (err) {
          console.error('保存标注失败:', err);
          return res.status(500).json({
            success: false,
            message: '保存标注失败',
            error: err.message,
          });
        }

        return res.json({
          success: true,
          annotationId,
          message: '标注保存成功',
        });
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: '保存标注失败',
        error: error.message,
      });
    }
  });

  // 更新标注数据
  router.put('/:imageId', (req, res) => {
    try {
      const { imageId } = req.params;
      const annotationData = {
        imageId,
        ...req.body,
      };

      db.updateAnnotation(annotationData, (err, changes) => {
        if (err) {
          console.error('更新标注失败:', err);
          return res.status(500).json({
            success: false,
            message: '更新标注失败',
            error: err.message,
          });
        }

        return res.json({
          success: true,
          changes,
          message: '标注更新成功',
        });
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: '更新标注失败',
        error: error.message,
      });
    }
  });

  // 获取标注
  router.get('/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      db.getAnnotationByImageId(imageId, (err, row) => {
        if (err) {
          console.error('获取标注失败:', err);
          return res.status(500).json({ success: false, message: '获取标注失败', error: err.message });
        }
        return res.json({ success: true, annotation: row || null });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '获取标注失败', error: error.message });
    }
  });

  app.use('/api/annotations', router);
}

module.exports = { registerAnnotationRoutes };

