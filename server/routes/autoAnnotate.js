const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { getUploadsRootDir } = require('../utils/dataPaths');
const { debugLog } = require('../utils/debugSettingsStore');
const { RequestQueueLimiter } = require('../utils/requestQueueLimiter');

function registerAutoAnnotateRoutes(app, { db, buildImageUrl }) {
  const annotationQueue = new RequestQueueLimiter({
    key: 'sam2',
    maxConcurrent: 6,
    onDebug: (payload) => debugLog('node', 'nodeSam2Queue', payload),
  });

  async function checkGroundedSAM2Health(apiUrl) {
    try {
      const healthUrl = apiUrl.replace('/api/auto-label', '/health').replace('/api/auto-label', '');
      const response = await axios.get(healthUrl, { timeout: 5000 });
      return { available: true, status: response.status };
    } catch (error) {
      try {
        const baseUrl = apiUrl.replace('/api/auto-label', '');
        await axios.head(baseUrl, { timeout: 5000 });
        return { available: true, status: 200 };
      } catch (headError) {
        return {
          available: false,
          error: error.message || headError.message,
          code: error.code || headError.code,
        };
      }
    }
  }

  async function processAnnotationTask(imageId, modelParams) {
    const imgId = imageId;
    const params = modelParams;
    debugLog('node', 'nodeSam2Request', {
      imageId: imgId,
      hasModelParams: !!params,
    });

    const image = await new Promise((resolve, reject) => {
      db.getImageById(imgId, (err, img) => {
        if (err) reject(err);
        else resolve(img);
      });
    });

    if (!image) throw new Error(`未找到ID为 ${imgId} 的图片`);

    // 1) 优先使用数据库中的 file_path（历史上可能是宿主机绝对路径）
    let imagePath = image.file_path;
    const imageUrlPath = buildImageUrl(image.file_path, image.filename);
    const imageUrl = `http://localhost:3001${imageUrlPath}`;

    if (!fs.existsSync(imagePath)) {
      const uploadDir = getUploadsRootDir(); // e.g. /app/uploads inside container

      // 2) 根据对外 URL 反推容器内真实路径：
      //    /uploads/project_2/images/xxx.png -> /app/uploads/project_2/images/xxx.png
      let triedPaths = [imagePath];
      let altFromUrl = null;
      if (imageUrlPath && typeof imageUrlPath === 'string') {
        const normalizedUrlPath = String(imageUrlPath).replace(/\\/g, '/');
        const stripped = normalizedUrlPath.replace(/^\/+uploads\/+/i, '');
        if (stripped) {
          altFromUrl = path.join(uploadDir, stripped);
          triedPaths.push(altFromUrl);
        }
      }

      // 3) 兼容历史绝对路径：从旧路径中截取 project_X/... 后缀
      let altFromLegacy = null;
      if (!altFromUrl || !fs.existsSync(altFromUrl)) {
        const normalizedFilePath = String(image.file_path || '').replace(/\\/g, '/');
        const markerIdx = normalizedFilePath.search(/\/project_\d+\//i);
        if (markerIdx >= 0) {
          const rel = normalizedFilePath.slice(markerIdx + 1); // 去掉前导 '/'
          altFromLegacy = path.join(uploadDir, rel.replace(/^\/*/, ''));
          triedPaths.push(altFromLegacy);
        }
      }

      const candidates = [altFromUrl, altFromLegacy].filter(Boolean);
      const existing = candidates.find((p) => p && fs.existsSync(p));
      if (existing) {
        imagePath = existing;
      } else {
        const msg = `图片文件路径不存在（已尝试容器内多种路径拼接）：\n` + triedPaths.map((p) => `- ${p}`).join('\n');
        throw new Error(msg);
      }
    }

    const GROUNDED_SAM2_API_URL = process.env.GROUNDED_SAM2_API_URL || 'http://localhost:7860/api/auto-label';
    const healthCheck = await checkGroundedSAM2Health(GROUNDED_SAM2_API_URL);
    if (!healthCheck.available) {
      console.warn(`[AI标注] Grounded SAM2服务健康检查失败: ${healthCheck.error} (${healthCheck.code})`);
    }

    try {
      const formData = new FormData();
      const imageStream = fs.createReadStream(imagePath);
      formData.append('image', imageStream, path.basename(imagePath));
      // Pass identifiers so sam2-service debug can correlate to UI imageId/originalName.
      formData.append('imageId', String(imgId));
      formData.append(
        'imageOriginalName',
        String(image?.original_name || image?.filename || path.basename(imagePath)),
      );

      if (params && typeof params === 'object') {
        if (typeof params.maxPolygonPoints === 'number') formData.append('max_polygon_points', String(params.maxPolygonPoints));
        if (typeof params.sam2PointsPerSide === 'number') formData.append('sam2_points_per_side', String(params.sam2PointsPerSide));
        if (typeof params.sam2PredIouThresh === 'number') formData.append('sam2_pred_iou_thresh', String(params.sam2PredIouThresh));
        if (typeof params.sam2StabilityScoreThresh === 'number')
          formData.append('sam2_stability_score_thresh', String(params.sam2StabilityScoreThresh));
        if (typeof params.sam2BoxNmsThresh === 'number') formData.append('sam2_box_nms_thresh', String(params.sam2BoxNmsThresh));
        if (typeof params.sam2MinMaskRegionArea === 'number')
          formData.append('sam2_min_mask_region_area', String(params.sam2MinMaskRegionArea));
      }

      const samResponse = await axios.post(GROUNDED_SAM2_API_URL, formData, {
        headers: { ...formData.getHeaders() },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      const samData = samResponse.data;
      const annotations = { masks: [], boundingBoxes: [] };

      if (samData.masks || samData.segments) {
        const masksArr = samData.masks || [];
        const segmentsArr = samData.segments || [];

        masksArr.forEach((m, index) => {
          const points = m.points || m.contour || [];
          if (!points || points.length === 0) return;
          annotations.masks.push({
            id: m.id ? `annotation-${imgId}-${m.id}` : `annotation-${imgId}-${index}`,
            points: Array.isArray(points) ? points.flat() : [],
            label: m.label || m.class || 'object',
          });
        });

        segmentsArr.forEach((seg, index) => {
          const bbox = seg.bbox || { x: seg.x, y: seg.y, width: seg.width, height: seg.height };
          if (!bbox) return;
          const x1 = bbox.x ?? bbox[0] ?? 0;
          const y1 = bbox.y ?? bbox[1] ?? 0;
          const x2 = bbox.width != null ? x1 + bbox.width : bbox[2] ?? x1;
          const y2 = bbox.height != null ? y1 + bbox.height : bbox[3] ?? y1;

          annotations.boundingBoxes.push({
            id: seg.id ? `bbox-${imgId}-${seg.id}` : `bbox-${imgId}-${index}`,
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y2 - y1,
            label: seg.label || seg.class || 'object',
          });
        });
      } else if (samData.annotations) {
        const segments = Array.isArray(samData.annotations) ? samData.annotations : [samData.annotations];
        segments.forEach((segment, index) => {
          if (segment.mask || segment.points) {
            const points = segment.mask || segment.points || [];
            annotations.masks.push({
              id: `annotation-${imgId}-${index}`,
              points: points.flat(),
              label: segment.label || segment.class || 'object',
            });
          }
          if (segment.bbox || segment.bounding_box) {
            const bbox = segment.bbox || segment.bounding_box;
            annotations.boundingBoxes.push({
              id: `bbox-${imgId}-${index}`,
              x: bbox.x || bbox[0] || 0,
              y: bbox.y || bbox[1] || 0,
              width: bbox.width || (bbox[2] - bbox[0]) || 0,
              height: bbox.height || (bbox[3] - bbox[1]) || 0,
              label: segment.label || segment.class || 'object',
            });
          }
        });
      }

      return {
        success: true,
        annotations,
        message: `自动标注完成，检测到 ${annotations.masks.length + annotations.boundingBoxes.length} 个对象`,
        imageUrl,
      };
      
    } catch (samError) {
      const isAxiosError = samError && (samError.isAxiosError || samError.config || samError.response);
      if (isAxiosError && samError.response) {
        const upstreamStatus = samError.response.status;
        let upstreamData = samError.response.data;
        try {
          if (typeof upstreamData !== 'string') upstreamData = JSON.stringify(upstreamData);
        } catch (_) {
          upstreamData = String(upstreamData);
        }
        const truncated = upstreamData && upstreamData.length > 2000 ? `${upstreamData.slice(0, 2000)}...(truncated)` : upstreamData;
        console.error(`[AI标注] Grounded SAM2 上游返回非 2xx: status=${upstreamStatus}, data=${truncated}`);
        throw new Error(`Grounded SAM2 API 调用失败: status=${upstreamStatus}, data=${truncated || '(empty)'}`);
      }

      if (samError && (samError.code === 'ECONNREFUSED' || samError.code === 'ETIMEDOUT' || samError.code === 'ENOTFOUND')) {
        throw new Error(`Grounded SAM2 服务不可用: ${samError.message}`);
      }

      const msg = samError && samError.message ? samError.message : String(samError);
      throw new Error(`Grounded SAM2 调用异常: ${msg}`);
    }
  }

  const router = express.Router();

  router.post('/auto', async (req, res) => {
    try {
      const { imageId, modelParams } = req.body;
      const sessionId = req.sessionID;
      const { taskId, promise } = annotationQueue.enqueue({
        sessionId,
        payload: { imageId, modelParams },
        worker: async ({ imageId: taskImageId, modelParams: taskModelParams }) => {
          const result = await processAnnotationTask(taskImageId, taskModelParams);
          debugLog('node', 'nodeSam2Result', {
            imageId: taskImageId,
            success: true,
            masks: Number(result?.annotations?.masks?.length || 0),
            bboxes: Number(result?.annotations?.boundingBoxes?.length || 0),
          });
          return result;
        },
      });
      debugLog('node', 'nodeSam2Queue', { stage: 'request-enqueued', taskId, imageId: Number(imageId), sessionId });
      const result = await promise;
      return res.json(result);
    } catch (error) {
      debugLog('node', 'nodeSam2Result', {
        imageId: Number(req?.body?.imageId || 0),
        success: false,
        message: error?.message || String(error),
      });
      console.error('[AI标注] 处理失败:', error);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: '自动标注失败',
          error: error.message,
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        });
      }
    }
  });

  router.get('/queue-status', (req, res) => {
    const taskId = String(req.query?.taskId || '').trim();
    if (taskId) {
      const status = annotationQueue.getTaskStatus(taskId);
      return res.json({ success: true, queue: 'sam2', status: status || null });
    }
    const status = annotationQueue.getSessionStatus(req.sessionID);
    return res.json({ success: true, queue: 'sam2', status });
  });

  app.use('/api/annotate', router);
}

module.exports = { registerAutoAnnotateRoutes };

