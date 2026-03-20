const express = require('express');
const fs = require('fs');

function registerImageRoutes(app, { db, buildImageUrl }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { projectId } = req.query;

      if (projectId) {
        const sessionId = req.sessionID;
        const hasAccess = await db.hasProjectAccess(sessionId, projectId);
        if (!hasAccess && (!req.session || !req.session.isAdmin)) {
          return res.status(403).json({
            success: false,
            error: '没有访问该项目的权限，请先输入验证码',
          });
        }
      } else if (!req.session || !req.session.isAdmin) {
        return res.status(403).json({
          success: false,
          error: '需要指定项目ID或管理员权限',
        });
      }

      const handleResult = (err, images) => {
        if (err) {
          console.error('获取图片列表失败:', err);
          return res.status(500).json({
            success: false,
            message: '获取图像列表失败',
            error: err.message,
          });
        }

        const formattedImages = images.map((img) => ({
          id: img.id,
          filename: img.filename,
          originalName: img.original_name,
          url: buildImageUrl(img.file_path, img.filename),
          size: img.file_size,
          width: img.width,
          height: img.height,
          uploadTime: img.upload_time,
        }));

        return res.json({ success: true, images: formattedImages });
      };

      if (projectId) db.getImagesByProjectId(projectId, handleResult);
      else db.getAllImages(handleResult);
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: '获取图像列表失败',
        error: error.message,
      });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const imageId = parseInt(req.params.id, 10);
      console.log(`[DELETE /api/images/${imageId}] 开始删除图片，ID: ${imageId}`);

      if (Number.isNaN(imageId)) {
        return res.status(400).json({
          success: false,
          message: '无效的图片ID',
          error: 'ID必须是数字',
        });
      }

      db.getImageById(imageId, (err, image) => {
        if (err) {
          return res.status(500).json({
            success: false,
            message: '查询图片信息失败',
            error: err.message,
          });
        }

        if (!image) {
          return res.status(404).json({
            success: false,
            message: '图片不存在',
          });
        }

        db.deleteImage(imageId, (deleteErr, changes) => {
          if (deleteErr) {
            return res.status(500).json({
              success: false,
              message: '删除数据库记录失败',
              error: deleteErr.message,
            });
          }

          if (changes === 0) {
            return res.status(404).json({
              success: false,
              message: '图片不存在',
            });
          }

          if (image.file_path && fs.existsSync(image.file_path)) {
            fs.unlink(image.file_path, (unlinkErr) => {
              if (unlinkErr) console.error(`[DELETE /api/images/${imageId}] 删除物理文件失败:`, unlinkErr);
            });
          }

          return res.json({
            success: true,
            message: '图片删除成功',
            deletedId: imageId,
            changes,
          });
        });
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: '删除图片失败',
        error: error.message,
      });
    }
  });

  app.use('/api/images', router);
}

module.exports = { registerImageRoutes };

