const express = require('express');
const { debugLog } = require('../utils/debugSettingsStore');

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
        // SAM2 重新生成 mask 后，实例顺序与 id 可能变化；同步清空该图历史 6D/9D 结果，避免旧结果错绑新 mask。
        db.clearPose9DByImageId(imageId, async () => {
          try {
            const projectIds = await db.getProjectIdsByImageId(Number(imageId));
            const projectId = Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null;
            if (projectId) {
              // 注意：之前这里是“fire-and-forget”，导致批量 AI 保存完后 label-color upsert 仍在后台跑。
              // 在压力场景下会造成数据库竞争，从而拖慢紧随其后的 /auth/check /label-colors /annotations 请求。
              // 这里等待 upsert 完成后再返回，保证后续页面切换更稳定。
              await new Promise((resolve) => {
                db.upsertProjectLabelColorsFromAnnotation(projectId, annotationData, (mapErr, upserted) => {
                  debugLog('node', 'nodeProjectLabelColors', '[annotations.save] upsert from annotation', {
                    imageId: Number(imageId),
                    projectId,
                    upserted: Number(upserted || 0),
                    error: mapErr ? String(mapErr.message || mapErr) : null,
                  });
                  resolve();
                });
              });
            }
          } catch (_) {}
          return res.json({
            success: true,
            annotationId,
            message: '标注保存成功',
          });
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
        // 更新 2D mask 后，清理该图历史姿态结果，确保后续 diffdope 以新实例集重算。
        db.clearPose9DByImageId(imageId, async () => {
          try {
            const projectIds = await db.getProjectIdsByImageId(Number(imageId));
            const projectId = Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null;
            if (projectId) {
              await new Promise((resolve) => {
                db.upsertProjectLabelColorsFromAnnotation(projectId, annotationData, (mapErr, upserted) => {
                  debugLog('node', 'nodeProjectLabelColors', '[annotations.update] upsert from annotation', {
                    imageId: Number(imageId),
                    projectId,
                    upserted: Number(upserted || 0),
                    error: mapErr ? String(mapErr.message || mapErr) : null,
                  });
                  resolve();
                });
              });
            }
          } catch (_) {}
          return res.json({
            success: true,
            changes,
            message: '标注更新成功',
          });
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

