const express = require('express');
const axios = require('axios');

function registerPoseRoutes(app, { db, requireImageProjectAccess, poseServiceUrl }) {
  const router = express.Router();

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

  router.post('/pose9d/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const meshId = req.body?.meshId ?? req.body?.mesh?.id ?? null;
      const pose = req.body?.pose9d ?? req.body?.pose ?? req.body ?? {};
      db.savePose9D(imageId, meshId, pose, (err, id) => {
        if (err) return res.status(500).json({ success: false, message: '保存 9D Pose 失败', error: err.message });
        return res.json({ success: true, id, message: '9D Pose 保存成功' });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存 9D Pose 失败', error: error.message });
    }
  });

  router.get('/pose9d/:imageId', requireImageProjectAccess, (req, res) => {
    try {
      const { imageId } = req.params;
      const meshId = req.query?.meshId ?? null;
      db.getPose9D(imageId, meshId, (err, row) => {
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
      db.deletePose9D(imageId, meshId, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '删除 9D Pose 失败', error: err.message });
        return res.json({ success: true, changes, message: '9D Pose 已删除' });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '删除 9D Pose 失败', error: error.message });
    }
  });

  router.post('/pose9d/:imageId/:meshId/diffdope-pose44', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.params.meshId);
      const pose44 = req.body?.pose44;
      const valid =
        Array.isArray(pose44) &&
        pose44.length === 4 &&
        pose44.every((r) => Array.isArray(r) && r.length >= 4 && r.slice(0, 4).every((v) => Number.isFinite(Number(v))));
      if (!imageId || !meshId || !valid) {
        return res.status(400).json({ success: false, message: 'pose44 非法，需为 4x4 数值矩阵' });
      }
      db.getPose9D(imageId, meshId, (err, row) => {
        if (err) return res.status(500).json({ success: false, message: '读取现有姿态失败', error: err.message });
        const prev = row?.diffdope && typeof row.diffdope === 'object' ? row.diffdope : {};
        const next = {
          ...prev,
          method: 'diffdope',
          pose44,
          updatedAt: new Date().toISOString(),
        };
        db.updatePose9DDiffDope(imageId, meshId, next, row?.fitOverlayPath || null, (uErr) => {
          if (uErr) return res.status(500).json({ success: false, message: '写入 pose44 失败', error: uErr.message });
          return res.json({ success: true, message: 'pose44 已保存', imageId, meshId, pose44 });
        });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存 pose44 失败', error: error?.message || String(error) });
    }
  });

  router.post('/pose6d/:imageId/diffdope-estimate', requireImageProjectAccess, async (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      if (!imageId || Number.isNaN(imageId)) return res.status(400).json({ success: false, message: '非法的 imageId' });

      const debug = !!req.body?.debug;
      const dbgLog = (...args) => {
        if (!debug) return;
        try {
          // eslint-disable-next-line no-console
          console.log(...args);
        } catch (_) {}
      };
      const summarizeMaskFlat = (flat) => {
        const arr = Array.isArray(flat) ? flat : [];
        return {
          points: Math.floor(arr.length / 2),
          flatLen: arr.length,
          head: arr.slice(0, 10),
          tail: arr.slice(Math.max(0, arr.length - 10)),
        };
      };

      const projectIds = await db.getProjectIdsByImageId(imageId);
      const projectIdFromBody = req.body?.projectId != null ? Number(req.body.projectId) : null;
      const projectId = projectIdFromBody || (Array.isArray(projectIds) && projectIds.length ? Number(projectIds[0]) : null);
      if (!projectId) return res.status(400).json({ success: false, message: '无法确定该图片所属项目（projectId 缺失）' });

      const onlyUniqueMasks = req.body?.onlyUniqueMasks !== false;
      const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[_\-]+/g, '');

      dbgLog('[pose6d][diffdope][debug] incoming body:', {
        imageId,
        projectIdFromBody,
        projectIdResolved: projectId,
        onlyUniqueMasks,
        iters: req.body?.iters,
        batchSize: req.body?.batchSize,
        lrLow: req.body?.lrLow,
        lrHigh: req.body?.lrHigh,
        baseLr: req.body?.baseLr,
        lrDecay: req.body?.lrDecay,
        useMaskLoss: req.body?.useMaskLoss,
        useRgbLoss: req.body?.useRgbLoss,
        useDepthLoss: req.body?.useDepthLoss,
        weightMask: req.body?.weightMask,
        weightRgb: req.body?.weightRgb,
        weightDepth: req.body?.weightDepth,
        returnDebugImages: req.body?.returnDebugImages,
        poseServiceUrl,
      });

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

      dbgLog('[pose6d][diffdope][debug] imageRow:', {
        imageId,
        file_path: imageRow?.file_path,
        filename: imageRow?.filename,
        original_name: imageRow?.original_name,
        width: imageRow?.width,
        height: imageRow?.height,
      });
      dbgLog('[pose6d][diffdope][debug] masks:', {
        count: masks.length,
        labels: Array.from(new Set(masks.map((m) => m.label))),
        sample: masks.slice(0, 5).map((m) => ({ id: m.id, index: m.index, label: m.label, pointsLen: Array.isArray(m.points) ? m.points.length : 0 })),
      });

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
      dbgLog('[pose6d][diffdope][debug] project meshes:', {
        count: meshes.length,
        sample: meshes.slice(0, 8).map((m) => ({ id: m.id, skuLabel: m.skuLabel, filename: m.filename, originalName: m.originalName, filePath: m.filePath })),
      });
      const findMeshForLabel = (label) => {
        const k = normalizeKey(label);
        if (!k) return null;
        return (
          meshes.find((m) => normalizeKey(m.skuLabel) === k) ||
          meshes.find((m) => normalizeKey(m.skuLabel).includes(k)) ||
          meshes.find((m) => normalizeKey(`${m.originalName || ''}${m.filename || ''}`).includes(k)) ||
          null
        );
      };

      const depthRows = await new Promise((resolve, reject) => {
        db.getDepthMapsByImageId(projectId, imageId, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      });
      const depthRawRow =
        (depthRows || []).find((d) => d?.modality === 'depth_raw' || String(d?.original_name || d?.filename || '').toLowerCase().endsWith('.npy')) ||
        null;
      const depthPngRow =
        (depthRows || []).find((d) => d?.modality === 'depth_png' || String(d?.original_name || d?.filename || '').toLowerCase().endsWith('.png')) ||
        null;
      const depthRow = depthRawRow || depthPngRow;
      let intrRow =
        (depthRows || []).find((d) => d?.modality === 'intrinsics' || /^intrinsics_/i.test(String(d?.original_name || d?.filename || ''))) ||
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
              original_name: cam.intrinsics_original_name,
              filename: (cam.intrinsics_file_path || '').split(/[\\/]/).pop(),
              modality: 'intrinsics',
              role: cam.role,
              camera_id: cam.id,
            };
          }
        } catch (_) {}
      }
      if (!depthRow?.file_path) {
        return res.status(400).json({ success: false, message: '缺少深度文件（优先 depth_raw_*.npy；无 raw 时可回退 depth_png）' });
      }
      if (!intrRow?.file_path) return res.status(400).json({ success: false, message: '缺少 intrinsics_*.json（请先上传相机内参）' });

      dbgLog('[pose6d][diffdope][debug] depth/intrinsics resolved:', {
        depthPng: {
          id: depthRow?.id,
          filename: depthRow?.filename,
          original_name: depthRow?.original_name,
          modality: depthRow?.modality,
          file_path: depthRow?.file_path,
        },
        intrinsics: {
          filename: intrRow?.filename,
          original_name: intrRow?.original_name,
          modality: intrRow?.modality,
          role: intrRow?.role,
          camera_id: intrRow?.camera_id,
          file_path: intrRow?.file_path,
        },
      });

      const results = [];
      const failures = [];

      for (const [label, arr] of byLabel.entries()) {
        if (onlyUniqueMasks && arr.length !== 1) {
          failures.push(`${label}: mask 数量=${arr.length}（当前仅处理唯一 mask）`);
          continue;
        }
        const mesh = findMeshForLabel(label);
        if (!mesh) {
          failures.push(`${label}: 未找到可匹配的 Mesh（建议把 Mesh 的 skuLabel 设置成与 mask label 一致）`);
          continue;
        }
        if (!mesh.filePath) {
          failures.push(`${label}: Mesh 缺少 file_path，无法运行 diffdope`);
          continue;
        }
        const mask = arr[0];
        const flat = Array.isArray(mask.points) ? mask.points.flat(Infinity).filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
        if (flat.length < 6) {
          failures.push(`${label}: mask 点集为空/非法`);
          continue;
        }
        dbgLog('[pose6d][diffdope][debug] task:', {
          label,
          mask: { id: mask.id ?? null, index: mask.index ?? 0, ...summarizeMaskFlat(flat) },
          mesh: { id: mesh.id, skuLabel: mesh.skuLabel, filename: mesh.filename, originalName: mesh.originalName, filePath: mesh.filePath },
        });

        const payload = {
          projectId,
          imageId,
          meshId: mesh.id,
          rgbPath: imageRow.file_path,
          depthPath: depthRow.file_path,
          intrinsicsPath: intrRow.file_path,
          meshPath: mesh.filePath,
          maskFlatPoints: flat,
          stage1Iters: req.body?.stage1Iters ?? 80,
          stage2Iters: req.body?.stage2Iters ?? 120,
          iters: req.body?.iters ?? 60,
          batchSize: req.body?.batchSize ?? 8,
          lrLow: req.body?.lrLow ?? 0.01,
          lrHigh: req.body?.lrHigh ?? 100,
          baseLr: req.body?.baseLr ?? 20,
          lrDecay: req.body?.lrDecay ?? 0.1,
          useMaskLoss: req.body?.useMaskLoss ?? true,
          useRgbLoss: req.body?.useRgbLoss ?? false,
          useDepthLoss: req.body?.useDepthLoss ?? true,
          stage1WeightMask: req.body?.stage1WeightMask ?? 1,
          stage2WeightMask: req.body?.stage2WeightMask ?? 0.5,
          stage2WeightDepth: req.body?.stage2WeightDepth ?? 1,
          stage1EarlyStopLoss: req.body?.stage1EarlyStopLoss ?? null,
          stage2EarlyStopLoss: req.body?.stage2EarlyStopLoss ?? null,
          stage2BaseLr: req.body?.stage2BaseLr ?? 20,
          stage2LrDecay: req.body?.stage2LrDecay ?? 0.1,
          maxAllowedFinalLoss: req.body?.maxAllowedFinalLoss ?? null,
          weightMask: req.body?.weightMask ?? 1,
          weightRgb: req.body?.weightRgb ?? 0.7,
          weightDepth: req.body?.weightDepth ?? 1,
          returnDebugImages: req.body?.returnDebugImages ?? true,
          debug,
        };
        dbgLog('[pose6d][diffdope][debug] payload -> pose-service (maskFlatPoints omitted):', {
          ...payload,
          maskFlatPoints: summarizeMaskFlat(flat),
        });

        try {
          const t0 = Date.now();
          const resp = await axios.post(`${poseServiceUrl}/diffdope/estimate6d`, payload, { timeout: 10 * 60 * 1000 });
          const httpMs = Date.now() - t0;
          const poseOut = resp.data;
          // 始终输出 quality gate 关键字段，定位“loss 很大却未报错”的原因。
          // eslint-disable-next-line no-console
          console.log('[pose6d][diffdope][quality-gate]', {
            label,
            meshId: mesh.id,
            requestMaxAllowedFinalLoss: payload.maxAllowedFinalLoss ?? null,
            serviceCode: poseOut?.code || null,
            serviceSuccess: poseOut?.success,
            serviceError: poseOut?.error || null,
            qualityGate: poseOut?.meta?.stages?.qualityGate || poseOut?.meta || null,
          });
          if (!poseOut?.success) {
            const qg = poseOut?.meta?.stages?.qualityGate || poseOut?.meta || {};
            failures.push(
              `${label}: diffdope 结果未通过: ${poseOut?.error || 'unknown error'}`
              + ` (stage2Loss=${qg?.stage2ScalarLoss ?? qg?.stage2BatchMeanLoss ?? 'n/a'}, gate=${qg?.maxAllowedFinalLoss ?? payload.maxAllowedFinalLoss ?? 'n/a'})`,
            );
            continue;
          }
          dbgLog('[pose6d][diffdope][debug] pose-service response summary:', {
            httpMs,
            success: poseOut?.success,
            argmin: poseOut?.argmin,
            timingSec: poseOut?.timingSec,
            hasPose44: Array.isArray(poseOut?.pose44),
            debugImages: poseOut?.debugImages
              ? {
                  hasOverlayRgb: !!poseOut?.debugImages?.overlayRgbPngB64,
                  hasLossPlot: !!poseOut?.debugImages?.lossPlotPngB64,
                  err: poseOut?.debugImages?.error || null,
                }
              : null,
            meta: poseOut?.meta || null,
          });
          results.push({ label, meshId: mesh.id, maskId: mask.id ?? null, maskIndex: mask.index ?? 0, pose: poseOut });

          try {
            const pose44Raw = Array.isArray(poseOut?.pose44) ? poseOut.pose44 : null;
            const pose44 = convertPose44OpenGLToOpenCV(pose44Raw) || pose44Raw;
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
            // Always print this core chain to help diagnose "pose unchanged / axis flipped".
            // Do not gate behind req.body.debug.
            // eslint-disable-next-line no-console
            console.log('[pose6d][diffdope][trace] post-process pose chain:', {
              label,
              meshId: mesh.id,
              servicePoseDiagnostics: poseOut?.meta?.poseDiagnostics || null,
              pose44Raw_t: pose44Raw ? [pose44Raw?.[0]?.[3], pose44Raw?.[1]?.[3], pose44Raw?.[2]?.[3]] : null,
              pose44Cv_t: pose44 ? [pose44?.[0]?.[3], pose44?.[1]?.[3], pose44?.[2]?.[3]] : null,
              dbPositionCm: nextPose.positionCm,
              dbRotationDeg: nextPose.rotationDeg,
            });

            await new Promise((resolve, reject) => db.savePose9D(imageId, mesh.id, nextPose, (err) => (err ? reject(err) : resolve())));
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
              );
            });
          } catch (e) {
            console.warn('[pose6d][diffdope] 写回 pose9d_annotations 失败（不影响返回）:', e);
          }
        } catch (e) {
          const status = e?.response?.status;
          const detail = e?.response?.data || e?.message || String(e);
          failures.push(`${label}: diffdope 调用失败${status ? ` (HTTP ${status})` : ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        }
      }

      const ok = results.length > 0;
      return res.status(ok ? 200 : 422).json({
        success: ok,
        imageId,
        projectId,
        results,
        failures,
        poseServiceUrl,
        message: ok ? undefined : '本次 AI 6D 标注未产出可用结果',
      });
    } catch (e) {
      console.error('❌ POST /api/pose6d/:imageId/diffdope-estimate 处理失败:', e);
      return res.status(500).json({ success: false, message: '6D 姿态推测失败', error: e?.message || String(e) });
    }
  });

  app.use('/api', router);
}

module.exports = { registerPoseRoutes };

