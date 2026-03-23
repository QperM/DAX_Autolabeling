const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

  const regenerateCompositeFitOverlay = async ({ imageId, projectId, imageRow, debug = false }) => {
    try {
      if (!imageRow?.file_path) return null;
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
          pose44: p.diffdope.pose44,
        });
      }
      if (!objects.length) return null;

      const payload = {
        projectId,
        imageId,
        rgbPath: imageRow.file_path,
        depthPath: depthRow?.file_path || null,
        intrinsicsPath: intrRow?.file_path,
        objects,
        debug: !!debug,
      };
      const rendered = await axios.post(`${poseServiceUrl}/diffdope/render-fit-overlay`, payload, { timeout: 10 * 60 * 1000 });
      const fitOverlayPath = rendered?.data?.fitOverlayPath || null;
      if (!fitOverlayPath) return null;

      // 清理历史 mesh 级 overlay，强制收敛到“一个 image 一张拟合图”。
      try {
        const fitDir = path.join(__dirname, '..', 'uploads', `project_${Number(projectId)}`, 'pose-fit-overlays');
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
        db.updatePose9DDiffDope(imageId, meshId, diffdopeJson, fitOverlayPath, () => resolve(null));
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
        return res.json({ success: true, imageId, meshId, changes: Number(changes || 0), initialPose: payload });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '保存初始位姿失败', error: error?.message || String(error) });
    }
  });

  // 仅删除人工初始位姿：保留 diffdope_json（最终位姿）
  router.delete('/pose9d/:imageId/initial-pose', requireImageProjectAccess, (req, res) => {
    try {
      const imageId = Number(req.params.imageId);
      const meshId = Number(req.query?.meshId ?? req.body?.meshId);
      if (!imageId || !meshId || Number.isNaN(meshId)) {
        return res.status(400).json({ success: false, message: 'invalid imageId/meshId' });
      }
      db.deletePose9DInitialPose(imageId, meshId, (err, changes) => {
        if (err) return res.status(500).json({ success: false, message: '删除初始位姿失败', error: err.message });
        return res.json({ success: true, imageId, meshId, changes: Number(changes || 0) });
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: '删除初始位姿失败', error: error?.message || String(error) });
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
      db.getPose9D(imageId, meshId, async (err, row) => {
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
            if (projectId) {
              await regenerateCompositeFitOverlay({ imageId, projectId, imageRow, debug: false });
            }
          } catch (_) {}
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
      const useInitialPose = req.body?.useInitialPose === true;
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
        useInitialPose,
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
      const usedInitialPoseMeshIds = new Set();
      const initialPoseByMeshId = new Map();
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
        } catch (e) {
          dbgLog('[pose6d][diffdope][debug] load initialPose map failed:', e?.message || e);
        }
      }

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

        const b = req.body || {};
        const legacyRgb = b.useRgbLoss === true;
        const legacyDepth = b.useDepthLoss !== false;
        const initPose44 = useInitialPose ? (initialPoseByMeshId.get(Number(mesh.id)) || null) : null;
        const skipStage1 = !!initPose44;
        const payload = {
          projectId,
          imageId,
          meshId: mesh.id,
          rgbPath: imageRow.file_path,
          depthPath: depthRow.file_path,
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
          debug,
        };
        dbgLog('[pose6d][diffdope][debug] payload -> pose-service (maskFlatPoints omitted):', {
          ...payload,
          maskFlatPoints: summarizeMaskFlat(flat),
        });
        dbgLog('[pose6d][diffdope][debug] loss_switches_resolved (must match pose-service trace):', {
          label,
          meshId: mesh.id,
          stage1UseMask: payload.stage1UseMask,
          stage1UseRgb: payload.stage1UseRgb,
          stage2UseMask: payload.stage2UseMask,
          stage2UseDepth: payload.stage2UseDepth,
          stage2UseRgb: payload.stage2UseRgb,
          stage1WeightMask: payload.stage1WeightMask,
          stage1WeightRgb: payload.stage1WeightRgb,
          stage2WeightMask: payload.stage2WeightMask,
          stage2WeightDepth: payload.stage2WeightDepth,
          stage2WeightRgb: payload.stage2WeightRgb,
          stage1Iters: payload.stage1Iters,
          stage2Iters: payload.stage2Iters,
          batchSize: payload.batchSize,
          useInitialPose,
          hasInitialPoseForMesh: !!initPose44,
          skipStage1,
          debug: payload.debug,
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
          if (skipStage1) usedInitialPoseMeshIds.add(Number(mesh.id));
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
            useInitialPose,
            skipStage1,
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
            if (skipStage1) {
              await new Promise((resolve) => {
                db.updatePose9DInitialPose(imageId, mesh.id, null, () => resolve());
              });
            }
          } catch (e) {
            console.warn('[pose6d][diffdope] 写回 pose9d_annotations 失败（不影响返回）:', e);
          }
        } catch (e) {
          const status = e?.response?.status;
          const detail = e?.response?.data || e?.message || String(e);
          failures.push(`${label}: diffdope 调用失败${status ? ` (HTTP ${status})` : ''}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
        }
      }

      // 同图多 mesh：生成一张“合成拟合图层”（覆盖所有已写入 pose44 的 mesh）
      // 并回写到该 image 的所有 pose 记录，避免前端只显示最后一个 sku 的拟合图。
      try {
        await regenerateCompositeFitOverlay({ imageId, projectId, imageRow, debug });
      } catch (_) {}

      const ok = results.length > 0;
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
      });
    } catch (e) {
      console.error('❌ POST /api/pose6d/:imageId/diffdope-estimate 处理失败:', e);
      return res.status(500).json({ success: false, message: '6D 姿态推测失败', error: e?.message || String(e) });
    }
  });

  app.use('/api', router);
}

module.exports = { registerPoseRoutes };

