const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { getUploadsRootDir } = require('../utils/dataPaths');
const { debugLog } = require('../utils/debugSettingsStore');

function registerAutoAnnotateRoutes(app, { db, buildImageUrl }) {
  // ========== AI标注任务队列管理器 ==========
  const MAX_CONCURRENT_TASKS = 10;

  class AnnotationTaskQueue {
    constructor() {
      this.runningTasks = new Map(); // taskId -> { imageId, startTime, sessionId }
      this.waitingQueue = []; // [{ taskId, imageId, modelParams, req, res, sessionId, timestamp }]
      this.taskIdCounter = 0;
    }

    generateTaskId() {
      return `task_${Date.now()}_${++this.taskIdCounter}`;
    }

    getRunningTaskCount() {
      return this.runningTasks.size;
    }

    getQueuePosition(taskId) {
      const index = this.waitingQueue.findIndex((t) => t.taskId === taskId);
      return index >= 0 ? index + 1 : null;
    }

    async addTask(imageId, modelParams, req, res, isAdmin) {
      const taskId = this.generateTaskId();
      const sessionId = req.sessionID;

      if (isAdmin) {
        this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });
        return { taskId, immediate: true };
      }

      if (this.runningTasks.size < MAX_CONCURRENT_TASKS) {
        this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });
        return { taskId, immediate: true };
      }

      const queuePosition = this.waitingQueue.length + 1;
      this.waitingQueue.push({
        taskId,
        imageId,
        modelParams,
        req,
        res,
        sessionId,
        timestamp: Date.now(),
      });
      return { taskId, immediate: false, queuePosition };
    }

    completeTask(taskId) {
      if (this.runningTasks.has(taskId)) {
        this.runningTasks.delete(taskId);
        this.processNextInQueue();
      }
    }

    async processNextInQueue() {
      if (this.waitingQueue.length === 0) return;
      if (this.runningTasks.size >= MAX_CONCURRENT_TASKS) return;

      const nextTask = this.waitingQueue.shift();
      if (!nextTask) return;

      const { taskId, imageId, modelParams, req, res, sessionId } = nextTask;
      this.runningTasks.set(taskId, { imageId, startTime: Date.now(), sessionId });

      this.executeTask(taskId, imageId, modelParams, req, res).catch((err) => {
        console.error(`[任务队列] 任务 ${taskId} 执行失败:`, err);
        this.completeTask(taskId);
      });
    }

    async executeTask(taskId, imageId, modelParams, req, res) {
      try {
        const result = await processAnnotationTask(imageId, modelParams);
        if (!res.headersSent) res.json(result);
        this.completeTask(taskId);
      } catch (error) {
        console.error(`[任务队列] 任务 ${taskId} 执行出错:`, error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: '自动标注失败',
            error: error.message,
          });
        }
        this.completeTask(taskId);
      }
    }

    getStatus() {
      return {
        running: this.runningTasks.size,
        waiting: this.waitingQueue.length,
        maxConcurrent: MAX_CONCURRENT_TASKS,
      };
    }
  }

  const annotationQueue = new AnnotationTaskQueue();

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

    let imagePath = image.file_path;
    const imageUrlPath = buildImageUrl(image.file_path, image.filename);
    const imageUrl = `http://localhost:3001${imageUrlPath}`;

    if (!fs.existsSync(imagePath)) {
      const uploadDir = getUploadsRootDir();
      const alternativePath = path.join(uploadDir, image.filename);
      if (fs.existsSync(alternativePath)) imagePath = alternativePath;
      else throw new Error(`图片文件路径不存在: ${image.file_path}`);
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
        if (typeof params.sam2MergeGapPx === 'number')
          formData.append('sam2_merge_gap_px', String(params.sam2MergeGapPx));
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
      const isAdmin = req.session && req.session.isAdmin === true;

      const { taskId, immediate, queuePosition } = await annotationQueue.addTask(imageId, modelParams, req, res, isAdmin);

      if (!immediate) {
        return res.status(429).json({
          success: false,
          message: '服务器当前负载较高，您的任务已加入队列',
          error: 'SERVER_OVERLOAD',
          taskId,
          queuePosition,
          maxConcurrent: MAX_CONCURRENT_TASKS,
          currentRunning: annotationQueue.getRunningTaskCount(),
          estimatedWaitTime: queuePosition * 30,
        });
      }

      try {
        const result = await processAnnotationTask(imageId, modelParams);
        debugLog('node', 'nodeSam2Result', {
          imageId,
          success: true,
          masks: Number(result?.annotations?.masks?.length || 0),
          bboxes: Number(result?.annotations?.boundingBoxes?.length || 0),
        });
        annotationQueue.completeTask(taskId);
        return res.json(result);
      } catch (error) {
        debugLog('node', 'nodeSam2Result', {
          imageId,
          success: false,
          message: error?.message || String(error),
        });
        annotationQueue.completeTask(taskId);
        throw error;
      }
    } catch (error) {
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
    const status = annotationQueue.getStatus();
    res.json(status);
  });

  app.use('/api/annotate', router);
}

module.exports = { registerAutoAnnotateRoutes };

