const express = require('express');
const fs = require('fs');
const { debugLog } = require('../utils/debugSettingsStore');

function registerImageRoutes(app, { db, buildImageUrl, projectSessionGuard }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const { projectId } = req.query;
      const offset = req.query?.offset;
      const limit = req.query?.limit;

      if (projectId) {
        const sessionId = req.sessionID;
        const hasAccess = await db.hasProjectAccess(sessionId, projectId);
        if (!hasAccess && (!req.session || !req.session.isAdmin)) {
          return res.status(403).json({
            success: false,
            error: '没有访问该项目的权限，请先输入验证码',
          });
        }
        if (!req.session?.isAdmin && projectSessionGuard) {
          const guardResult = projectSessionGuard.check({ sessionId, projectId: Number(projectId) });
          if (!guardResult?.ok) {
            return res.status(409).json({
              success: false,
              error: guardResult?.message || '有其他人操作此项目了，当前连接已断开。',
              code: guardResult?.code || 'PROJECT_CONTROL_TAKEN',
              disconnect: true,
            });
          }
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
          originalName: img.original_name != null ? String(img.original_name) : '',
          url: buildImageUrl(img.file_path, img.filename),
          size: img.file_size,
          width: img.width,
          height: img.height,
          uploadTime: img.upload_time,
        }));

        return res.json({ success: true, images: formattedImages });
      };

      if (projectId) {
        db.getImagesByProjectId(projectId, handleResult, {
          offset,
          limit,
        });
      } else {
        db.getAllImages(handleResult, { offset, limit });
      }
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
      debugLog('node', 'node2DDelete', { stage: 'received', imageId });
      console.log(`[DELETE /api/images/${imageId}] 开始删除图片，ID: ${imageId}`);

      if (Number.isNaN(imageId)) {
        return res.status(400).json({
          success: false,
          message: '无效的图片ID',
          error: 'ID必须是数字',
        });
      }

      const unlinkIfExists = async (filePath) => {
        const p = String(filePath || '').trim();
        if (!p) return false;
        try {
          await fs.promises.access(p, fs.constants.F_OK);
          await fs.promises.unlink(p);
          return true;
        } catch (_) {
          return false;
        }
      };

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

        db.getProjectIdsByImageId(imageId)
          .then(async (projectIds) => {
            const projectId = Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null;
            const cleanupStats = {
              filesDeleted: 0,
              depthRowsDeleted: 0,
              fitOverlaysDeleted: 0,
            };

            // 1) 先收集并清理与该图片关联的 pose 拟合图（数据库记录随后由外键级联删除）
            const poseRows = await new Promise((resolve) => {
              db.listPose9DByImageId(imageId, (poseErr, rows) => {
                if (poseErr) return resolve([]);
                return resolve(Array.isArray(rows) ? rows : []);
              });
            });
            for (const r of poseRows) {
              if (await unlinkIfExists(r?.fitOverlayPath)) {
                cleanupStats.filesDeleted += 1;
                cleanupStats.fitOverlaysDeleted += 1;
              }
            }

            if (projectId) {
              // 2) 删除与图片关联的 depth/rgbd 文件 + depth 修复文件，并删除 depth_maps 记录（不影响 cameras）
              const depthRows = await new Promise((resolve) => {
                db.getDepthMapsByImageId(projectId, imageId, (depthErr, rows) => {
                  if (depthErr) return resolve([]);
                  return resolve(Array.isArray(rows) ? rows : []);
                });
              });
              for (const row of depthRows) {
                const deletedMain = await unlinkIfExists(row?.file_path);
                const deletedRawFix = await unlinkIfExists(row?.depth_raw_fix_path);
                const deletedPngFix = await unlinkIfExists(row?.depth_png_fix_path);
                cleanupStats.filesDeleted += Number(!!deletedMain) + Number(!!deletedRawFix) + Number(!!deletedPngFix);
              }
              cleanupStats.depthRowsDeleted = await new Promise((resolve, reject) => {
                db.deleteDepthMapsByImageId(projectId, imageId, (depthDelErr, changes) => {
                  if (depthDelErr) return reject(depthDelErr);
                  return resolve(Number(changes || 0));
                });
              });

              // 3) 清理 depth_repair_records 关联的修复产物（记录本身由外键级联删除）
              const repairRows = await new Promise((resolve) => {
                db.listDepthRepairRecordsByImageId(projectId, imageId, (repairErr, rows) => {
                  if (repairErr) return resolve([]);
                  return resolve(Array.isArray(rows) ? rows : []);
                });
              });
              for (const row of repairRows) {
                const deletedRaw = await unlinkIfExists(row?.depth_raw_path);
                const deletedPng = await unlinkIfExists(row?.depth_png_path);
                const deletedRawFix = await unlinkIfExists(row?.depth_raw_fix_path);
                const deletedPngFix = await unlinkIfExists(row?.depth_png_fix_path);
                cleanupStats.filesDeleted +=
                  Number(!!deletedRaw) + Number(!!deletedPng) + Number(!!deletedRawFix) + Number(!!deletedPngFix);
              }
            }

            // 4) 删除 image 主记录（annotations/pose9d/project_images/depth_repair_records 将由外键级联删除）
            const changes = await new Promise((resolve, reject) => {
              db.deleteImage(imageId, (deleteErr, deleteChanges) => {
                if (deleteErr) return reject(deleteErr);
                return resolve(Number(deleteChanges || 0));
              });
            });

            if (changes === 0) {
              return res.status(404).json({
                success: false,
                message: '图片不存在',
              });
            }

            // 5) 最后删除 RGB 原图文件
            if (await unlinkIfExists(image.file_path)) {
              cleanupStats.filesDeleted += 1;
            }

            debugLog('node', 'node2DDelete', {
              stage: 'completed',
              imageId,
              changes,
              cleanupStats,
            });
            return res.json({
              success: true,
              message: '图片删除成功',
              deletedId: imageId,
              changes,
              cleanupStats,
            });
          })
          .catch((cleanupErr) => {
            console.error(`[DELETE /api/images/${imageId}] 级联清理失败:`, cleanupErr);
            return res.status(500).json({
              success: false,
              message: '删除图片失败（级联清理异常）',
              error: cleanupErr.message,
            });
          });
      });
    } catch (error) {
      debugLog('node', 'node2DDelete', { stage: 'error', imageId: req.params.id, message: error?.message || String(error) });
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

