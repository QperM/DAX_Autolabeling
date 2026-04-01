const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getUploadsRootDir } = require('../utils/dataPaths');
const { debugLog } = require('../utils/debugSettingsStore');
const { ConcurrencyGate } = require('../utils/concurrencyGate');

function registerPoseRoutes(app, { db, requireImageProjectAccess, poseServiceUrl }) {
  const router = express.Router();
  // imageId -> 单图 diffdope 执行进度（内存态，供前端轮询）
  const estimateProgressByImageId = new Map();
  const diffdopeGate = new ConcurrencyGate({
    key: 'diffdope',
    maxConcurrent: 1,
    onDebug: (payload) => debugLog('node', 'nodeDiffdopeQueue', payload),
  });

  const rad2deg = (r) => (Number(r) * 180) / Math.PI;

  // Inverse of R = Rz * Ry * Rx (intrinsic XYZ) as used elsewhere in this codebase.
  // Returns degrees in range [-180, 180] (best-effort; gimbal lock handled by setting z=0).
  const rotmatToEulerXYZDeg = (R) => {
    // R is 3x3 array-like
    const r00 = Number(R?.[0]?.[0]); const r01 = Number(R?.[0]?.[1]); const r02 = Number(R?.[0]?.[2]);
    const r10 = Number(R?.[1]?.[0]); const r11 = Number(R?.[1]?.[1]); const r12 = Number(R?.[1]?.[2]);
    const r20 = Number(R?.[2]?.[0]); const r21 = Number(R?.[2]?.[1]); const r22 = Number(R?.[2]?.[2]);
    if (![r00,r01,r02,r10,r11,r12,r20,r21,r22].every((v) => Number.isFinite(v))) return { x: 0, y: 0, z: 0 };

    // For R = Rz*Ry*Rx:
    // sy = -r20
    const sy = -r20;
    const cy = Math.sqrt(Math.max(0, 1 - sy * sy));
    let x, y, z;
    if (cy > 1e-6) {
      x = Math.atan2(r21, r22);
      y = Math.asin(sy);
      z = Math.atan2(r10, r00);
    } else {
      // Gimbal lock: y is +-90deg, set z=0 and solve x from remaining terms
      x = Math.atan2(-r01, r11);
      y = Math.asin(sy);
      z = 0;
    }
    const wrap = (deg) => {
      let d = Number(deg);
      if (!Number.isFinite(d)) return 0;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    };
    return { x: wrap(rad2deg(x)), y: wrap(rad2deg(y)), z: wrap(rad2deg(z)) };
  };

  // Diff-DOPE内部使用OpenGL坐标约定；本系统DB/前端使用OpenCV约定。
  // OpenGL -> OpenCV: C = diag(1,-1,-1), T_cv = C * T_gl * C
  const convertPose44OpenGLToOpenCV = (pose44) => {
    if (!Array.isArray(pose44) || pose44.length < 4) return null;
    const M = pose44.map((r) => (Array.isArray(r) ? r.map((v) => Number(v)) : []));
    if (![0, 1, 2, 3].every((i) => Array.isArray(M[i]) && M[i].length >= 4)) return null;
    const C = [1, -1, -1];
    const out = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ];

    // R_cv = C * R_gl * C  (C is diagonal)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) out[i][j] = C[i] * M[i][j] * C[j];
    }
    // t_cv = C * t_gl
    out[0][3] = C[0] * M[0][3];
    out[1][3] = C[1] * M[1][3];
    out[2][3] = C[2] * M[2][3];
    return out;
  };

  const regenerateCompositeFitOverlay = async ({ imageId, projectId, imageRow }) => {
    try {
      if (!imageRow?.file_path) return null;
      const depthRows = await new Promise((resolve, reject) => {
        db.getDepthMapsByImageId(projectId, imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      const depthRawRow =
        (depthRows || []).find((d) => d?.modality === 'depth_raw' || String(d?.filename || '').toLowerCase().endsWith('.npy')) ||
        null;
      const depthPngRow =
        (depthRows || []).find((d) => d?.modality === 'depth_png' || String(d?.filename || '').toLowerCase().endsWith('.png')) ||
        null;
      const depthRow = depthRawRow || depthPngRow;
      let intrRow =
        (depthRows || []).find((d) => d?.modality === 'intrinsics' || /^intrinsics_/i.test(String(d?.filename || ''))) ||
        null;
      if (!intrRow?.file_path) {
        const cameras = await new Promise((resolve) => {
          db.listCamerasByProjectId(projectId, (cErr, cRows) => {
            if (cErr) return resolve([]);
            return resolve(Array.isArray(cRows) ? cRows : []);
          });
        });
        intrRow = (cameras || []).find((c) => c?.role === (depthRow?.role || 'head') && c?.intrinsics_file_path)
          || (cameras || []).find((c) => c?.intrinsics_file_path)
          || null;
        if (intrRow?.intrinsics_file_path && !intrRow?.file_path) {
          intrRow = { ...intrRow, file_path: intrRow.intrinsics_file_path };
        }
      }
      if (!intrRow?.file_path) {
        // eslint-disable-next-line no-console
        console.warn('[pose9d] regenerate composite fit overlay skipped: intrinsics missing');
        return null;
      }

      const poses = await new Promise((resolve, reject) => {
        db.listPose9DByImageId(imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      const valid = (poses || []).filter((p) => Array.isArray(p?.diffdope?.pose44) && Number(p?.mesh_id ?? p?.meshId) > 0);
      if (!valid.length) return null;

      const objects = [];
      for (const p of valid) {
        const meshId = Number(p?.mesh_id ?? p?.meshId);
        // eslint-disable-next-line no-await-in-loop
        const meshRow = await new Promise((resolve, reject) => {
          db.getMeshById(meshId, (err, row) => (err ? reject(err) : resolve(row || null)));
        });
        if (!meshRow?.file_path) continue;
        objects.push({
          meshId,
          meshPath: meshRow.file_path,
          meshOriginalName: meshRow.original_name || meshRow.filename,
          meshSkuLabel: meshRow.sku_label ?? null,
          pose44: p.diffdope.pose44,
        });
      }
      if (!objects.length) return null;

      const payload = {
        projectId,
        imageId,
        imageOriginalName: imageRow?.original_name || imageRow?.filename || null,
        rgbPath: imageRow.file_path,
        depthPath: depthRow?.file_path || null,
        intrinsicsPath: intrRow?.file_path,
        objects,
        // debug: verbose diffdope overlay trace disabled
        debug: false,
      };

      debugLog('node', 'nodeDiffdopeResult', {
        stage: 'request',
        projectId: Number(projectId),
        imageId: Number(imageId),
        objectsCount: objects.length,
        meshIds: objects.map((o) => o.meshId),
      });

      const rendered = await axios.post(`${poseServiceUrl}/diffdope/render-fit-overlay`, payload, { timeout: 10 * 60 * 1000 });
      const r = rendered?.data || {};
      const fitOverlayPath = r?.fitOverlayPath || null;

      // Also capture backend's success/error fields even if HTTP status is 200
      debugLog('node', 'nodeDiffdopeResult', {
        stage: 'response',
        http200: true,
        success: r?.success,
        error: r?.error || null,
        fitOverlayPath,
        renderedCount: r?.renderedCount ?? null,
        timingSec: r?.timingSec ?? null,
      });

      // Validate whether the expected composite file exists on disk.
      if (fitOverlayPath) {
        try {
          const abs = path.join(getUploadsRootDir(), fitOverlayPath.replace(/^\/uploads\//, ''));
          // 避免“HTTP 返回了但文件还没写完/合成仍在落盘”导致前端显示时机过早。
          // 简单等待：文件 size 连续稳定几次（或超时）。
          const deadline = Date.now() + 8000;
          let lastSize = -1;
          let stableCount = 0;
          while (Date.now() < deadline) {
            try {
              if (fs.existsSync(abs)) {
                const st = fs.statSync(abs);
                const size = Number(st?.size || 0);
                if (size > 0) {
                  if (size === lastSize) stableCount += 1;
                  else stableCount = 0;
                  lastSize = size;
                  if (stableCount >= 3) break; // 连续 3 次稳定
                }
              }
            } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const exists = fs.existsSync(abs);
          debugLog('node', 'nodeDiffdopeResult', { stage: 'disk_wait', abs, exists, lastSize, stableCount });

          if (!exists) {
            const fitDir = path.dirname(abs);
            const names = fs.existsSync(fitDir) ? fs.readdirSync(fitDir).filter((n) => n.includes(`fit_image_${Number(imageId)}`)) : [];
            debugLog('node', 'nodeDiffdopeResult', { stage: 'disk_miss_hint', fitDir, names });
          }
        } catch (e) {
          debugLog('node', 'nodeDiffdopeResult', { stage: 'disk_check_error', error: e?.message || String(e) });
        }
      }

      if (!fitOverlayPath) return null;

      // 清理历史 mesh 级 overlay，强制收敛到“一个 image 一张拟合图”。
      try {
        const fitDir = path.join(getUploadsRootDir(), `project_${Number(projectId)}`, 'pose-fit-overlays');
        const pref = `fit_image_${Number(imageId)}_mesh_`;
        if (fs.existsSync(fitDir)) {
          for (const name of fs.readdirSync(fitDir)) {
            if (name.startsWith(pref) && name.endsWith('.png')) {
              try { fs.unlinkSync(path.join(fitDir, name)); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // 将合成图路径回写到该 image 的所有 pose 记录，前端拟合图层读任意一条都可命中
      await Promise.all(valid.map((row) => new Promise((resolve) => {
        const meshId = Number(row?.mesh_id ?? row?.meshId);
        const diffdopeJson = row?.diffdope && typeof row.diffdope === 'object' ? row.diffdope : {};
        db.updatePose9DDiffDope(
          imageId,
          meshId,
          diffdopeJson,
          fitOverlayPath,
          () => resolve(null),
          { maskId: row?.mask_id ?? row?.maskId ?? null, maskIndex: row?.mask_index ?? row?.maskIndex ?? null },
        );
      })));
      return fitOverlayPath;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[pose9d] regenerate composite fit overlay failed:', e?.message || e);
      return null;
    }
  };

  router.post('/pose9d/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const meshId = req.body?.meshId ?? req.body?.mesh?.id ?? null;
      const maskId = req.body?.maskId ?? null;
      const maskIndex = req.body?.maskIndex ?? null;
      const pose = req.body?.pose9d ?? req.body?.pose ?? req.body ?? {};
      db.savePose9D(imageId, meshId, pose, (err, id) => {
        if (err) return res.status(500).json({ success: false, message: '保存 9D Pose 失败', error: err.message });
        return res.json({ success: true, id, message: '9D Pose 保存成功' });
      }, { maskId, maskIndex });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存 9D Pose 失败', error: error.message });
    }
  });

  router.get('/pose9d/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const meshId = req.query?.meshId ?? null;
      const maskId = req.query?.maskId ?? null;
      db.getPose9D(imageId, meshId, maskId, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: '获取 9D Pose 失败', error: err.message });
        return res.json({ success: true, pose9d: row ? row.pose : null, record: row || null });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '获取 9D Pose 失败', error: error.message });
    }
  });

  router.get('/pose9d/:imageId/all', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      db.listPose9DByImageId(imageId, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: '获取 9D Pose 列表失败', error: err.message });
        return res.json({ success: true, poses: rows || [] });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '获取 9D Pose 列表失败', error: error.message });
    }
  });

  router.delete('/pose9d/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const meshId = req.query?.meshId ?? null;
      const maskId = req.query?.maskId ?? null;
      db.deletePose9D(imageId, meshId, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '删除 9D Pose 失败', error: err.message });
        return res.json({ success: true, changes, message: '9D Pose 已删除' });
      }, { maskId });
    } catch (error) {
      return res.status(500).json({ success: false, message: '删除 9D Pose 失败', error: error.message });
    }
  });

  // 清除本图内所有 6D/9D 位姿标注（同时删除 diffdope_json + initial_pose_json）
  router.delete('/pose9d/:imageId/clear-6d', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      if (!imageId || Number.isNaN(imageId)) return res.status(400).json({ success: false, message: '非法的 imageId' });
      db.clearPose9DByImageId(imageId, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '清除 6D 姿态标注失败', error: err.message });
        return res.json({ success: true, imageId, changes: Number(changes || 0) });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '清除 6D 姿态标注失败', error: error?.message || String(error) });
    }
  });

  router.post('/pose9d/:imageId/initial-pose', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.body?.meshId);
      const maskId = typeof req.body?.maskId === 'string' ? req.body.maskId.trim() : null;
      const maskIndex = req.body?.maskIndex ?? null;
      const pose44 = req.body?.pose44;
      const valid =
        Array.isArray(pose44) &&
        pose44.length === 4 &&
        pose44.every((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every((v) => Number.isFinite(Number(v))));
      if (!imageId || !meshId || !valid) {
        return res.status(400).json({ success: false, message: 'initial pose 非法，需提供 meshId 与 4x4 pose44 数值矩阵' });
      }
      const payload = { pose44, updatedAt: new Date().toISOString() };
      db.updatePose9DInitialPose(imageId, meshId, payload, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '保存初始位姿失败', error: err.message });
        return res.json({ success: true, imageId, meshId, maskId, changes: Number(changes || 0), initialPose: payload });
      }, { maskId, maskIndex });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存初始位姿失败', error: error?.message || String(error) });
    }
  });

  // 仅删除人工初始位姿：保留 diffdope_json（最终位姿）
  router.delete('/pose9d/:imageId/initial-pose', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.query?.meshId ?? req.body?.meshId);
      const maskId = typeof (req.query?.maskId ?? req.body?.maskId) === 'string'
        ? String(req.query?.maskId ?? req.body?.maskId).trim()
        : null;
      if (!imageId || !meshId || Number.isNaN(meshId)) {
        return res.status(400).json({ success: false, message: 'invalid imageId/meshId' });
      }
      db.deletePose9DInitialPose(imageId, meshId, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '删除初始位姿失败', error: err.message });
        return res.json({ success: true, imageId, meshId, maskId, changes: Number(changes || 0) });
      }, { maskId });
    } catch (error) {
      return res.status(500).json({ success: false, message: '删除初始位姿失败', error: error?.message || String(error) });
    }
  });

  // 清空“最终位姿”（diffdope_json）：将 diffdope_json 置为 '{}'，前端按 diffdope.pose44 是否存在判断 final 是否存在。
  router.delete('/pose9d/:imageId/:meshId/diffdope-pose44', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.params.meshId);
      const maskId =
        typeof (req.query?.maskId ?? req.body?.maskId) === 'string' ? String(req.query?.maskId ?? req.body?.maskId).trim() : null;
      if (!imageId || !meshId || Number.isNaN(meshId)) {
        return res.status(400).json({ success: false, message: 'invalid imageId/meshId' });
      }

      // 尽量保留原 mask_index，避免更新时把 mask_index 写成 null
      db.getPose9D(imageId, meshId, maskId, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: '读取现有姿态失败', error: err.message });
        const maskIndex = row?.mask_index ?? row?.maskIndex ?? null;
        const actualMaskId = row?.mask_id ?? row?.maskId ?? maskId ?? null;

        db.updatePose9DDiffDope(
          imageId,
          meshId,
          null,
          null,
          (uErr) => {
            if (uErr) return res.status(500).json({ success: false, message: '清空 diffdope_json 失败', error: uErr.message });
            return res.json({ success: true, imageId, meshId, maskId: actualMaskId, cleared: true });
          },
          { maskId: actualMaskId, maskIndex },
        );
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '清空 diffdope_json 失败', error: error?.message || String(error) });
    }
  });

  router.post('/pose9d/:imageId/:meshId/diffdope-pose44', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.params.meshId);
      const maskId = typeof req.body?.maskId === 'string' ? req.body.maskId.trim() : null;
      const skipFitOverlay = req.body?.skipFitOverlay === true;
      const pose44 = req.body?.pose44;
      const valid =
        Array.isArray(pose44) &&
        pose44.length === 4 &&
        pose44.every((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every((v) => Number.isFinite(Number(v))));
      if (!imageId || !meshId || !valid) {
        return res.status(400).json({ success: false, message: 'pose44 非法，需为 4x4 数值矩阵' });
      }
      db.getPose9D(imageId, meshId, maskId, async (err, row) => {
        if (err) return res.status(500).json({ success: false, message: '读取现有姿态失败', error: err.message });
        const prev = row?.diffdope && typeof row.diffdope === 'object' ? row.diffdope : {};
        const next = {
          ...prev,
          method: 'diffdope',
          pose44,
          updatedAt: new Date().toISOString(),
        };
        db.updatePose9DDiffDope(imageId, meshId, next, row?.fitOverlayPath || null, async (uErr) => {
          if (uErr) return res.status(500).json({ success: false, message: '写入 pose44 失败', error: uErr.message });
          try {
            const [projectIds, imageRow] = await Promise.all([
              db.getProjectIdsByImageId(imageId),
              new Promise((resolve, reject) => db.getImageById(imageId, (e, r) => (e ? reject(e) : resolve(r || null)))),
            ]);
            const projectId = Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null;
            if (!skipFitOverlay && projectId) {
              await regenerateCompositeFitOverlay({ imageId, projectId, imageRow });
            }
          } catch (_) {}
          return res.json({ success: true, message: 'pose44 已保存', imageId, meshId, maskId, pose44 });
        }, { maskId });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存 pose44 失败', error: error?.message || String(error) });
    }
  });

  // 为“保存全部实例最终位姿”提供：只对当前 image 做一次拟合图层合成
  router.post('/pose9d/:imageId/regenerate-fit-overlay', requireImageProjectAccess, async (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      if (!imageId || Number.isNaN(imageId)) return res.status(400).json({ success: false, message: '非法的 imageId' });

      const projectIds = await db.getProjectIdsByImageId(imageId);
      const projectId = Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null;
      if (!projectId) return res.status(400).json({ success: false, message: '无法确定该图片所属项目（projectId 缺失）' });

      const imageRow = await new Promise((resolve, reject) =>
        db.getImageById(imageId, (e, r) => (e ? reject(e) : resolve(r || null))),
      );

      const fitOverlayPath = await regenerateCompositeFitOverlay({ imageId, projectId, imageRow });
      return res.json({ success: true, imageId, projectId, fitOverlayPath });
    } catch (e) {
      return res.status(500).json({ success: false, message: '拟合图层合成失败', error: e?.message || String(e) });
    }
  });

  router.post('/pose6d/:imageId/diffdope-estimate', requireImageProjectAccess, async (req, res) => {
    let gateHandle = null;
    try {
      gateHandle = await diffdopeGate.enter(req.sessionID);
      const imageId = Number(req.params.imageId);
      if (!imageId || Number.isNaN(imageId)) return res.status(400).json({ success: false, message: '非法的 imageId' });
      debugLog('node', 'nodeDiffdopeRequest', {
        stage: 'received',
        imageId,
        projectIdFromBody: req.body?.projectId ?? null,
        onlyUniqueMasks: req.body?.onlyUniqueMasks,
        targetLabel: req.body?.targetLabel ?? null,
        onlySingleMesh: req.body?.onlySingleMesh ?? false,
        targetMeshId: req.body?.targetMeshId ?? null,
      });

      const projectIds = await db.getProjectIdsByImageId(imageId);
      const projectIdFromBody = req.body?.projectId != null ? Number(req.body.projectId) : null;
      const projectId = projectIdFromBody || (Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null);
      if (!projectId) return res.status(400).json({ success: false, message: '无法确定该图片所属项目（projectId 缺失）' });

      const onlyUniqueMasks = req.body?.onlyUniqueMasks !== false;
      const targetLabelRaw =
        typeof req.body?.targetLabel === 'string' ? String(req.body.targetLabel).trim() : '';
      const useInitialPose = req.body?.useInitialPose === true;
      const onlySingleMesh = req.body?.onlySingleMesh === true;
      const targetMeshIdNum =
        req.body?.targetMeshId != null && req.body?.targetMeshId !== '' ? Number(req.body?.targetMeshId) : null;
      const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[_\-]+/g, '');
      const targetLabelKey = targetLabelRaw ? normalizeKey(targetLabelRaw) : '';

      const imageRow = await new Promise((resolve, reject) => {
        db.getImageById(imageId, (err, row) => (err ? reject(err) : resolve(row || null)));
      });
      if (!imageRow?.file_path) return res.status(404).json({ success: false, message: '图片不存在或缺少 file_path' });

      const annoRow = await new Promise((resolve, reject) => {
        db.getAnnotationByImageId(imageId, (err, row) => (err ? reject(err) : resolve(row || null)));
      });
      const masks = (annoRow?.masks || []).map((m, index) => ({
        id: m.id,
        index,
        label: String(m.label || '').trim() || '未命名',
        points: m.points,
      }));
      if (!masks.length) return res.status(400).json({ success: false, message: '该图片没有可用的 mask（请先生成/保存 2D mask）' });

      const byLabel = new Map();
      for (const m of masks) {
        const arr = byLabel.get(m.label) || [];
        arr.push(m);
        byLabel.set(m.label, arr);
      }

      const meshRows = await new Promise((resolve, reject) => {
        db.getMeshesByProjectId(projectId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      const meshes = meshRows.map((row) => ({
        id: row.id,
        skuLabel: row.sku_label ?? null,
        filename: row.filename,
        originalName: row.original_name,
        filePath: row.file_path,
      }));
      // 仅按 Mesh 的 sku_label 与 mask label 做规范化后**全等**匹配（避免 includes/文件名子串误匹配到错误模型）。
      const findMeshForLabel = (label) => {
        const k = normalizeKey(label);
        if (!k) return null;
        return meshes.find((m) => normalizeKey(m.skuLabel) === k) || null;
      };

      const depthRows = await new Promise((resolve, reject) => {
        db.getDepthMapsByImageId(projectId, imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      const depthRawRow =
        (depthRows || []).find((d) => d?.modality === 'depth_raw' || String(d?.filename || '').toLowerCase().endsWith('.npy')) ||
        null;
      const depthPngRow =
        (depthRows || []).find((d) => d?.modality === 'depth_png' || String(d?.filename || '').toLowerCase().endsWith('.png')) ||
        null;
      const depthRow = depthRawRow || depthPngRow;
      const depthSource = String(req.body?.depthSource || 'raw').toLowerCase() === 'fix' ? 'fix' : 'raw';
      const depthFixPath = depthRawRow?.depth_raw_fix_path || depthPngRow?.depth_raw_fix_path || null;
      const depthRawPath = depthRawRow?.file_path || depthPngRow?.file_path || null;
      const selectedDepthPath = depthSource === 'fix' ? (depthFixPath || null) : depthRawPath;
      let intrRow =
        (depthRows || []).find((d) => d?.modality === 'intrinsics' || /^intrinsics_/i.test(String(d?.filename || ''))) ||
        null;
      // 兼容：intrinsics 可能存储在 cameras 表而不是 depth_maps
      if (!intrRow?.file_path) {
        try {
          const cameras = await new Promise((resolve) => {
            db.listCamerasByProjectId(projectId, (cErr, cRows) => {
              if (cErr) return resolve([]);
              resolve(cRows || []);
            });
          });
          const cam = (cameras || []).find((c) => c?.intrinsics_file_path) || null;
          if (cam?.intrinsics_file_path) {
            intrRow = {
              file_path: cam.intrinsics_file_path,
              filename: (cam.intrinsics_file_path || '').split(/[\\/]/).pop(),
              modality: 'intrinsics',
              role: cam.role,
              camera_id: cam.id,
            };
          }
        } catch (_) {}
      }
      if (!selectedDepthPath) {
        return res.status(400).json({
          success: false,
          message:
            depthSource === 'fix'
              ? '当前图片缺少修复深度（depth_raw_fix），请先执行“批量补全深度信息”或切换为原始深度。'
              : '缺少深度文件（优先 depth_raw_*.npy；无 raw 时可回退 depth_png）',
        });
      }
      if (!intrRow?.file_path) return res.status(400).json({ success: false, message: '缺少 intrinsics_*.json（请先上传相机内参）' });

      const results = [];
      const failures = [];
      let consideredLabelCount = 0;
      const usedInitialPoseMeshIds = new Set();
      const initialPoseByMeshId = new Map();
      const attemptedMeshIds = new Set();
      let lastRenderFitOverlayDiag = null;
      let lastFitOverlayPath = null;
      // 保存“本次 run 成功”时的 OpenCV pose44，供 render-fit-overlay 只渲染本次成功/尝试的 mesh，避免 stale DB pose 造成“看似成功其实没跑”的假象。
      const pose44ByMeshId = new Map();
      // 保存“本次 run 成功”的逐实例结果（同一 mesh 可出现多次，按 mask 实例区分）。
      const successfulRenderObjects = [];
      let matchedSelectedMesh = false;
      const totalWorkCount = onlyUniqueMasks ? byLabel.size : masks.length;

      estimateProgressByImageId.set(imageId, {
        running: true,
        phase: 'matching',
        total: totalWorkCount,
        started: 0,
        completed: 0,
        success: 0,
        failed: 0,
        currentLabel: null,
        currentMeshSkuLabel: null,
        message: '开始匹配 mask 与 mesh…',
        updatedAt: new Date().toISOString(),
      });
      if (onlySingleMesh) {
        if (!Number.isFinite(targetMeshIdNum) || targetMeshIdNum <= 0) {
          return res.status(400).json({ success: false, message: '开启仅标注单个模型时必须提供有效的 targetMeshId' });
        }
      }
      if (useInitialPose) {
        try {
          const poseRows = await new Promise((resolve, reject) => {
            db.listPose9DByImageId(imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
          });
          for (const row of (poseRows || [])) {
            const mid = Number(row?.mesh_id ?? row?.meshId ?? 0);
            const p44 = row?.initialPose?.pose44;
            const ok =
              Number.isFinite(mid) &&
              mid > 0 &&
              Array.isArray(p44) &&
              p44.length === 4 &&
              p44.every((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every((v) => Number.isFinite(Number(v))));
            if (ok) initialPoseByMeshId.set(mid, p44);
          }
        } catch (_) {}
      }
      const workEntries = [];
      for (const [label, arr] of byLabel.entries()) {
        if (onlyUniqueMasks) {
          workEntries.push([label, arr]);
        } else {
          for (const m of arr) workEntries.push([label, [m]]);
        }
      }
      for (const [label, arr] of workEntries) {
        {
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.started = Number(p.started || 0) + 1;
            p.currentLabel = label;
            p.currentMeshSkuLabel = null;
            p.message = `正在处理 ${p.started}/${p.total}: ${label}`;
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
        }
        if (targetLabelKey && normalizeKey(label) !== targetLabelKey) {
          continue;
        }
        consideredLabelCount += 1;
        if (onlyUniqueMasks && arr.length !== 1) {
          failures.push(`${label}: mask 数量=${arr.length}（当前仅处理唯一 mask）`);
          continue;
        }
        const mesh = findMeshForLabel(label);
        if (!mesh) {
          failures.push(`${label}: 未找到可匹配的 Mesh（建议把 Mesh 的 skuLabel 设置成与 mask label 一致）`);
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.completed = Number(p.completed || 0) + 1;
            p.failed = Number(p.failed || 0) + 1;
            p.message = `处理完成 ${p.completed}/${p.total}: ${label}（未匹配 Mesh）`;
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
          continue;
        }
        if (onlySingleMesh) {
          const mid = Number(mesh.id);
          if (mid !== targetMeshIdNum) continue;
          matchedSelectedMesh = true;
        }
        if (!mesh.filePath) {
          failures.push(`${label}: Mesh 缺少 file_path，无法运行 diffdope`);
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.completed = Number(p.completed || 0) + 1;
            p.failed = Number(p.failed || 0) + 1;
            p.message = `处理完成 ${p.completed}/${p.total}: ${label}（Mesh 缺少 file_path）`;
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
          continue;
        }
        {
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.currentMeshSkuLabel = mesh?.skuLabel || mesh?.originalName || mesh?.filename || null;
            p.message = `正在优化: ${label} -> ${p.currentMeshSkuLabel}（粗定位+精匹配）`;
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
        }
        attemptedMeshIds.add(Number(mesh.id));
        const mask = arr[0];
        const flat = Array.isArray(mask.points) ? mask.points.flat(Infinity).filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
        if (flat.length < 6) {
          failures.push(`${label}: mask 点集为空/非法`);
          continue;
        }
        const b = req.body || {};
        const legacyRgb = b.useRgbLoss === true;
        const legacyDepth = b.useDepthLoss !== false;
        const initPose44 = useInitialPose ? (initialPoseByMeshId.get(Number(mesh.id)) || null) : null;
        const skipStage1 = !!initPose44;
        const payload = {
          projectId,
          imageId,
          imageOriginalName: imageRow?.original_name || imageRow?.filename || null,
          meshId: mesh.id,
          meshOriginalName: mesh?.originalName || mesh?.filename || null,
          meshSkuLabel: mesh?.skuLabel || null,
          rgbPath: imageRow.file_path,
          depthPath: selectedDepthPath,
          intrinsicsPath: intrRow.file_path,
          meshPath: mesh.filePath,
          maskFlatPoints: flat,
          stage1Iters: b.stage1Iters ?? 80,
          stage2Iters: b.stage2Iters ?? 120,
          iters: b.iters ?? 60,
          batchSize: b.batchSize ?? 8,
          lrLow: b.lrLow ?? 0.01,
          lrHigh: b.lrHigh ?? 100,
          baseLr: b.baseLr ?? 20,
          lrDecay: b.lrDecay ?? 0.1,
          useMaskLoss: b.useMaskLoss ?? true,
          useRgbLoss: legacyRgb,
          useDepthLoss: legacyDepth,
          stage1UseMask: b.stage1UseMask !== false,
          stage1UseRgb: typeof b.stage1UseRgb === 'boolean' ? b.stage1UseRgb : legacyRgb,
          stage1UseDepth: false,
          stage2UseMask: typeof b.stage2UseMask === 'boolean' ? b.stage2UseMask : b.stage2UseMask !== false,
          stage2UseRgb: typeof b.stage2UseRgb === 'boolean' ? b.stage2UseRgb : legacyRgb,
          stage2UseDepth: typeof b.stage2UseDepth === 'boolean' ? b.stage2UseDepth : legacyDepth,
          stage1WeightMask: b.stage1WeightMask ?? 1,
          stage1WeightRgb: b.stage1WeightRgb ?? 0.7,
          stage1WeightDepth: b.stage1WeightDepth ?? 1,
          stage2WeightMask: b.stage2WeightMask ?? 1,
          stage2WeightDepth: b.stage2WeightDepth ?? 1,
          stage2WeightRgb: b.stage2WeightRgb ?? b.weightRgb,
          stage1EarlyStopLoss: b.stage1EarlyStopLoss ?? null,
          stage2EarlyStopLoss: b.stage2EarlyStopLoss ?? null,
          stage1BaseLr: b.stage1BaseLr ?? 20,
          stage1LrDecay: b.stage1LrDecay ?? 0.1,
          stage2BaseLr: b.stage2BaseLr ?? 8,
          stage2LrDecay: b.stage2LrDecay ?? 0.1,
          maxAllowedFinalLoss: b.maxAllowedFinalLoss ?? null,
          weightMask: b.weightMask ?? 1,
          // 第二轮 RGB 权重统一走 stage2WeightRgb（上式已含 b.weightRgb 回退）；勿默认塞 weightRgb，否则会覆盖 pose-service 的 DIFFDOPE_DEFAULTS
          weightDepth: b.weightDepth ?? 1,
          returnDebugImages: b.returnDebugImages ?? true,
          init: skipStage1 ? { pose44: initPose44 } : null,
          skipStage1,
          useInitialPose,
          debug: false,
        };

        try {
          const resp = await axios.post(`${poseServiceUrl}/diffdope/estimate6d`, payload, { timeout: 10 * 60 * 1000 });
          const poseOut = resp.data;
          if (!poseOut?.success) {
            const qg = poseOut?.meta?.stages?.qualityGate || poseOut?.meta || {};
            failures.push(
              `${label}: diffdope 结果未通过: ${poseOut?.error || 'unknown error'}`
              + ` (stage2Loss=${qg?.stage2ScalarLoss ?? qg?.stage2BatchMeanLoss ?? 'n/a'}, gate=${qg?.maxAllowedFinalLoss ?? payload.maxAllowedFinalLoss ?? 'n/a'})`,
            );
            const p = estimateProgressByImageId.get(imageId);
            if (p) {
              p.completed = Number(p.completed || 0) + 1;
              p.failed = Number(p.failed || 0) + 1;
              p.message = `处理完成 ${p.completed}/${p.total}: ${label}（质量门槛未通过）`;
              p.updatedAt = new Date().toISOString();
              estimateProgressByImageId.set(imageId, p);
            }
            continue;
          }
          if (skipStage1) usedInitialPoseMeshIds.add(Number(mesh.id));
          results.push({ label, meshId: mesh.id, maskId: mask.id ?? null, maskIndex: mask.index ?? 0, pose: poseOut });
          {
            const p = estimateProgressByImageId.get(imageId);
            if (p) {
              p.completed = Number(p.completed || 0) + 1;
              p.success = Number(p.success || 0) + 1;
              p.message = `处理完成 ${p.completed}/${p.total}: ${label}`;
              p.updatedAt = new Date().toISOString();
              estimateProgressByImageId.set(imageId, p);
            }
          }

          try {
            const pose44Raw = Array.isArray(poseOut?.pose44) ? poseOut.pose44 : null;
            const pose44 = convertPose44OpenGLToOpenCV(pose44Raw) || pose44Raw;
            pose44ByMeshId.set(Number(mesh.id), pose44);
            successfulRenderObjects.push({
              meshId: Number(mesh.id),
              maskId: mask.id ?? null,
              maskIndex: mask.index ?? 0,
              meshPath: mesh.filePath,
              meshOriginalName: mesh?.originalName || mesh?.filename || null,
              meshSkuLabel: mesh?.skuLabel || null,
              pose44,
            });
            const tCm = (() => {
              const tx = Number(pose44?.[0]?.[3]);
              const ty = Number(pose44?.[1]?.[3]);
              const tz = Number(pose44?.[2]?.[3]);
              return [tx, ty, tz].every((v) => Number.isFinite(v)) ? { x: tx, y: ty, z: tz } : { x: 0, y: 0, z: 0 };
            })();

            const rotDeg = (() => {
              if (!pose44 || !Array.isArray(pose44[0]) || pose44.length < 3) return { x: 0, y: 0, z: 0 };
              const R = [
                [pose44?.[0]?.[0], pose44?.[0]?.[1], pose44?.[0]?.[2]],
                [pose44?.[1]?.[0], pose44?.[1]?.[1], pose44?.[1]?.[2]],
                [pose44?.[2]?.[0], pose44?.[2]?.[1], pose44?.[2]?.[2]],
              ];
              return rotmatToEulerXYZDeg(R);
            })();

            // dimensions (mm) from mesh bbox_json when available
            let dimensionsCm = null;
            try {
              const meshRow = await new Promise((resolve, reject) => {
                db.getMeshById(mesh.id, (err, row) => (err ? reject(err) : resolve(row || null)));
              });
              if (meshRow?.bbox_json) {
                const bb = JSON.parse(meshRow.bbox_json);
                const sx = Number(bb?.size?.x);
                const sy = Number(bb?.size?.y);
                const sz = Number(bb?.size?.z);
                if ([sx, sy, sz].every((v) => Number.isFinite(v) && v > 0)) {
                  // bbox_json is stored in meters
                  dimensionsCm = { x: sx * 100, y: sy * 100, z: sz * 100 };
                }
              }
            } catch (_) {}

            const scale = 1;

            const nextPose = {
              positionCm: tCm,
              rotationDeg: rotDeg,
              scale,
              pose44,
              dimensionsCm,
            };

            await new Promise((resolve, reject) => db.savePose9D(
              imageId,
              mesh.id,
              nextPose,
              (err) => (err ? reject(err) : resolve()),
              { maskId: mask.id ?? null, maskIndex: mask.index ?? 0 },
            ));
            await new Promise((resolve) => {
              db.updatePose9DDiffDope(
                imageId,
                mesh.id,
                {
                  method: 'diffdope',
                  argmin: poseOut?.argmin ?? null,
                  timingSec: poseOut?.timingSec ?? null,
                  pose44,
                },
                poseOut?.fitOverlayPath || null,
                () => resolve(),
                { maskId: mask.id ?? null, maskIndex: mask.index ?? 0 },
              );
            });
            // AI 6D 成功写回后，统一清空该 mesh 的人工初始位姿，避免后续流程继续使用旧 initial_pose_json。
            await new Promise((resolve) => {
              db.updatePose9DInitialPose(
                imageId,
                mesh.id,
                null,
                () => resolve(),
                { maskId: mask.id ?? null, maskIndex: mask.index ?? 0 },
              );
            });
          } catch (e) {
            console.warn('[pose6d][diffdope] 写回 pose9d_annotations 失败（不影响返回）:', e);
          }
        } catch (e) {
          const status = e?.response?.status;
          const detail = e?.response?.data || e?.message || String(e);
          failures.push(`${label}: diffdope 调用失败${status ? ` (HTTP ${status})` : ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.completed = Number(p.completed || 0) + 1;
            p.failed = Number(p.failed || 0) + 1;
            p.message = `处理完成 ${p.completed}/${p.total}: ${label}（调用失败）`;
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
        }
      }

      if (targetLabelKey && consideredLabelCount === 0) {
        failures.push(`未找到目标 mask label：${targetLabelRaw}`);
      }

      if (onlySingleMesh && !matchedSelectedMesh) {
        failures.push('仅标注单个模型：当前图片的 mask label 与所选模型未匹配到可运行的 Mesh');
      }

      // 同图多 mesh：生成一张“合成拟合图层”（覆盖所有已写入 pose44 的 mesh）
      // 并回写到该 image 的所有 pose 记录，避免前端只显示最后一个 sku 的拟合图。
      try {
        {
          const p = estimateProgressByImageId.get(imageId);
          if (p) {
            p.phase = 'rendering';
            p.message = '正在合成拟合图层…';
            p.updatedAt = new Date().toISOString();
            estimateProgressByImageId.set(imageId, p);
          }
        }
        const imageOriginalName = imageRow?.original_name || imageRow?.filename || null;
        // 合成拟合图层应与“保存位置”一致：使用“当前图片数据库中的全部有效位姿”。
        // 本次 run 的成功实例（same image + mesh + mask）优先覆盖旧值，未触达的实例继续保留。
        const instanceKey = (meshId, maskId) => `${Number(meshId)}::${String(maskId || '').trim() || '__nomask__'}`;
        const renderObjectsByInstance = new Map();
        const dbPoseRows = await new Promise((resolve, reject) => {
          db.listPose9DByImageId(imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
        });
        for (const row of dbPoseRows || []) {
          const meshId = Number(row?.mesh_id ?? row?.meshId ?? 0);
          if (!Number.isFinite(meshId) || meshId <= 0) continue;
          const pose44 = row?.diffdope?.pose44;
          if (!Array.isArray(pose44) || pose44.length < 4) continue;
          const maskId = row?.mask_id ?? row?.maskId ?? null;
          const meshInfo = meshes.find((x) => Number(x.id) === meshId);
          const meshPath = meshInfo?.filePath || '';
          if (!meshPath) continue;
          renderObjectsByInstance.set(instanceKey(meshId, maskId), {
            meshId,
            meshPath,
            meshOriginalName: meshInfo?.originalName || meshInfo?.filename || null,
            meshSkuLabel: meshInfo?.skuLabel || null,
            pose44,
          });
        }
        for (const o of successfulRenderObjects) {
          if (!Array.isArray(o?.pose44) || o.pose44.length < 4 || !o.meshPath) continue;
          renderObjectsByInstance.set(instanceKey(o.meshId, o.maskId), {
            meshId: Number(o.meshId),
            meshPath: o.meshPath,
            meshOriginalName: o.meshOriginalName || null,
            meshSkuLabel: o.meshSkuLabel || null,
            pose44: o.pose44,
          });
        }
        const objects = Array.from(renderObjectsByInstance.values());

        if (intrRow?.file_path) {
          const payload = {
            projectId,
            imageId,
            imageOriginalName,
            rgbPath: imageRow.file_path,
            depthPath: selectedDepthPath,
            intrinsicsPath: intrRow.file_path,
            objects,
            debug: false,
          };

          debugLog('node', 'nodeDiffdopeResult', {
            stage: 'run_request',
            projectId: Number(projectId),
            imageId: Number(imageId),
            objectsCount: objects.length,
            meshIds: objects.map((o) => o.meshId),
          });

          const renderedResp = await axios.post(`${poseServiceUrl}/diffdope/render-fit-overlay`, payload, { timeout: 10 * 60 * 1000 });
          const r = renderedResp?.data || {};
          const renderDiag = {
            objectsCount: Number.isFinite(Number(r?.objectsCount)) ? Number(r.objectsCount) : Number(objects?.length || 0),
            renderedCount: Number.isFinite(Number(r?.renderedCount)) ? Number(r.renderedCount) : null,
            failedCount: Number.isFinite(Number(r?.failedCount)) ? Number(r.failedCount) : null,
            fitOverlayPath: r?.fitOverlayPath || null,
            timingSec: r?.timingSec ?? null,
          };
          lastRenderFitOverlayDiag = renderDiag;

          debugLog('node', 'nodeDiffdopeResult', {
            stage: 'run_response',
            http200: true,
            success: r?.success,
            error: r?.error || null,
            fitOverlayPath: r?.fitOverlayPath || null,
            renderedCount: r?.renderedCount ?? null,
            failedCount: r?.failedCount ?? null,
            timingSec: r?.timingSec ?? null,
          });

          const fitOverlayPath = r?.fitOverlayPath || null;
          lastFitOverlayPath = fitOverlayPath;
          if (renderDiag?.objectsCount === 0) {
            failures.push('[render-fit-overlay] objectsCount=0（合成拟合图层没有可渲染对象）');
          }
          if (fitOverlayPath) {
            try {
              const abs = path.join(getUploadsRootDir(), fitOverlayPath.replace(/^\/uploads\//, ''));
              const exists = fs.existsSync(abs);
              debugLog('node', 'nodeDiffdopeResult', {
                stage: 'run_disk',
                abs,
                exists,
              });
            } catch (e) {
              debugLog('node', 'nodeDiffdopeResult', {
                stage: 'run_disk_check_error',
                error: e?.message || String(e),
              });
            }

            // 关键修复：即便本次 image 不是“全成功”（例如部分 mask 失败），
            // 只要生成了 composite fitOverlay，就回写到该图片全部 pose 记录。
            // 这样人工标注页“拟合图层”可见性与实际生成结果一致（至少一条成功就能看到拟合图）。
            try {
              const poseRows = await new Promise((resolve, reject) => {
                db.listPose9DByImageId(imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
              });
              await Promise.all((poseRows || []).map((row) => new Promise((resolve) => {
                const meshId = Number(row?.mesh_id ?? row?.meshId);
                if (!Number.isFinite(meshId) || meshId <= 0) return resolve(null);
                const diffdopeJson = row?.diffdope && typeof row.diffdope === 'object' ? row.diffdope : {};
                db.updatePose9DDiffDope(
                  imageId,
                  meshId,
                  diffdopeJson,
                  fitOverlayPath,
                  () => resolve(null),
                  { maskId: row?.mask_id ?? row?.maskId ?? null, maskIndex: row?.mask_index ?? row?.maskIndex ?? null },
                );
              })));
              debugLog('node', 'nodeDiffdopeResult', {
                stage: 'run_writeback',
                imageId: Number(imageId),
                fitOverlayPath,
                rows: Array.isArray(poseRows) ? poseRows.length : 0,
              });
            } catch (e) {
              debugLog('node', 'nodeDiffdopeResult', {
                stage: 'run_writeback_error',
                imageId: Number(imageId),
                fitOverlayPath,
                error: e?.message || String(e),
              });
            }
          }
        }
      } catch (_) {}

      // Only fully successful when there are no per-mask failures.
      // (Missing mesh / diffdope call errors should all make the image fail.)
      const renderOk = !!lastFitOverlayPath && (lastRenderFitOverlayDiag?.objectsCount || 0) > 0;
      const ok = results.length > 0 && failures.length === 0 && renderOk;
      estimateProgressByImageId.set(imageId, {
        running: false,
        phase: 'done',
        total: totalWorkCount,
        started: totalWorkCount,
        completed: totalWorkCount,
        success: results.length,
        failed: failures.length,
        currentLabel: null,
        currentMeshSkuLabel: null,
        message: '处理完成',
        updatedAt: new Date().toISOString(),
      });
      debugLog('node', 'nodeDiffdopeResult', {
        stage: 'completed',
        imageId,
        projectId,
        success: ok,
        resultsCount: results.length,
        failuresCount: failures.length,
      });
      // 始终 200，便于 axios 拿到 failures（422 会导致前端抛错、用户看不到「未匹配 Mesh」等明细）。
      return res.status(200).json({
        success: ok,
        imageId,
        projectId,
        results,
        failures,
        usedInitialPoseMeshIds: Array.from(usedInitialPoseMeshIds),
        poseServiceUrl,
        message: ok ? undefined : (failures.length ? failures.join('；') : '本次 AI 6D 标注未产出可用结果'),
        renderFitOverlay: lastRenderFitOverlayDiag,
      });
    } catch (e) {
      console.error('❌ POST /api/pose6d/:imageId/diffdope-estimate 处理失败:', e);
      const imageId = Number(req.params.imageId);
      if (imageId && !Number.isNaN(imageId)) {
        estimateProgressByImageId.set(imageId, {
          running: false,
          phase: 'error',
          total: 0,
          started: 0,
          completed: 0,
          success: 0,
          failed: 0,
          currentLabel: null,
          currentMeshSkuLabel: null,
          message: e?.message || '处理失败',
          updatedAt: new Date().toISOString(),
        });
      }
      return res.status(500).json({ success: false, message: '6D 姿态推测失败', error: e?.message || String(e) });
    } finally {
      if (gateHandle?.release) gateHandle.release();
    }
  });

  router.get('/pose6d/queue-status', (req, res) => {
    const status = diffdopeGate.getSessionStatus(req.sessionID);
    return res.json({ success: true, queue: 'diffdope', status });
  });

  router.get('/pose6d/:imageId/diffdope-progress', requireImageProjectAccess, (req, res) => {
    const imageId = Number(req.params.imageId);
    if (!imageId || Number.isNaN(imageId)) {
      return res.status(400).json({ success: false, message: '非法的 imageId' });
    }
    const p = estimateProgressByImageId.get(imageId) || null;
    return res.json({ success: true, progress: p });
  });

  app.use('/api', router);
}

module.exports = { registerPoseRoutes };

