const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

function createDepthUpload() {
  const depthStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, '..', 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const original = String(file.originalname || 'depth.dat');
      const ext = (path.extname(original) || '').toLowerCase();
      const base = path.basename(original, ext || undefined).replace(/[^\w.\-() ]+/g, '_');
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${base}-${uniqueSuffix}${ext || ''}`);
    },
  });

  return multer({
    storage: depthStorage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = String(path.extname(file.originalname || '')).toLowerCase();
      if (['.png', '.tif', '.tiff'].includes(ext)) return cb(null, true);
      if (ext === '.npy') return cb(null, true);
      if (ext === '.json') return cb(null, true);
      cb(new Error('仅支持深度图 PNG/TIFF、.npy 原始深度数据或 intrinsics_*.json 相机内参'));
    },
  });
}

function registerDepthRoutes(app, { db, normalizeDepthKey, inferRoleFromFilename, buildImageUrl }) {
  const router = express.Router();
  const depthUpload = createDepthUpload();

  // 上传深度图 / 深度原始数据 / intrinsics_*.json
  router.post('/upload', depthUpload.array('depthFiles', 2000), async (req, res) => {
    try {
      const projectIdRaw = req.body?.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }

      // 预加载 cameras（用于把 depth_maps.camera_id 绑定到 cameras.id）
      const cameras = await new Promise((resolve) => {
        db.listCamerasByProjectId(projectId, (cErr, cRows) => {
          if (cErr) return resolve([]);
          resolve(cRows || []);
        });
      });
      const camerasArr = Array.isArray(cameras) ? cameras : [];
      const cameraByRole = new Map();
      for (const c of camerasArr) {
        const r = String(c?.role || '').trim().toLowerCase();
        if (!r) continue;
        if (!cameraByRole.has(r)) cameraByRole.set(r, c);
      }

      const baseUploadsDir = path.join(__dirname, '..', 'uploads');
      const projectDepthDir = path.join(baseUploadsDir, `project_${projectId}`, 'depth');
      if (!fs.existsSync(projectDepthDir)) {
        fs.mkdirSync(projectDepthDir, { recursive: true });
      }

      // 预加载该项目下的所有图片，用于按 original_name 绑定 image_id
      const projectImages = await new Promise((resolve, reject) => {
        db.getImagesByProjectId(projectId, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });

      // 预构建项目中所有 RGB 图片的 key -> imageId 映射
      const imageKeyMap = new Map();
      projectImages.forEach((img) => {
        const key = normalizeDepthKey(img.original_name || img.filename);
        if (!key) return;
        if (!imageKeyMap.has(key)) {
          imageKeyMap.set(key, img.id);
        }
      });

      const findImageIdForDepth = (origName) => {
        const key = normalizeDepthKey(origName);
        if (!key) return null;
        return imageKeyMap.get(key) || null;
      };

      const filesRaw = req.files || [];
      if (!filesRaw || filesRaw.length === 0) {
        return res.json({ success: true, files: [] });
      }

      const deleteTempFiles = (arr) => {
        for (const f of arr || []) {
          try {
            if (f?.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
          } catch (_) {}
        }
      };

      // 强校验：除 intrinsics_* 外，都必须匹配到 RGB
      const unmatched = [];
      const resolvedImageIds = new Map(); // filename -> imageId
      for (const f of filesRaw) {
        const ext = String(path.extname(f.originalname || '')).toLowerCase();
        const base = path.basename(f.originalname || '');
        const isIntrinsicsJson = ext === '.json' && /^intrinsics_/i.test(base);
        if (isIntrinsicsJson) continue;

        const imageId = findImageIdForDepth(f.originalname);
        if (!imageId) unmatched.push(f.originalname);
        else resolvedImageIds.set(f.filename, imageId);
      }

      if (unmatched.length > 0) {
        deleteTempFiles(filesRaw);

        return res.status(400).json({
          success: false,
          message:
            `深度数据上传失败：存在未匹配到 RGB 的文件（请检查命名格式）。\n\n` +
            `命名要求（key 必须一致）：\n` +
            `- rgb_<key>.<ext>\n` +
            `- depth_<key>.png\n` +
            `- depth_raw_<key>.npy\n\n` +
            `未匹配文件：\n- ${unmatched.join('\n- ')}`,
        });
      }

      const files = [];
      // 分两步：先处理 intrinsics_*.json（写入 cameras），再处理 depth_*（写入 depth_maps 并绑定 camera_id）
      const intrFiles = [];
      const depthFiles = [];
      for (const f of filesRaw) {
        const ext = String(path.extname(f.originalname || '')).toLowerCase();
        const base = path.basename(f.originalname || '');
        const isIntrinsicsJson = ext === '.json' && /^intrinsics_/i.test(base);
        if (isIntrinsicsJson) intrFiles.push(f);
        else depthFiles.push(f);
      }

      for (const f of intrFiles) {
        // move to project depth dir
        const finalPath = path.join(projectDepthDir, f.filename);
        try {
          fs.renameSync(f.path, finalPath);
        } catch (moveErr) {
          console.error('移动 Depth 文件到项目目录失败:', moveErr);
          return res.status(500).json({ success: false, message: '移动深度文件到项目目录失败' });
        }

        const rel = path.relative(baseUploadsDir, finalPath).replace(/\\/g, '/');
        const url = `/uploads/${rel
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/')}`;

        let role = inferRoleFromFilename(f.originalname);

        const ext = String(path.extname(f.originalname || '')).toLowerCase();
        let modality = null;
        if (ext === '.png' || ext === '.tif' || ext === '.tiff') modality = 'depth_png';
        else if (ext === '.npy') modality = 'depth_raw';
        else if (ext === '.json') modality = 'intrinsics_json';

        const base = path.basename(f.originalname || '');
        const isIntrinsicsJson = ext === '.json' && /^intrinsics_/i.test(base);

        if (isIntrinsicsJson) {
          if (!role) {
            return res.status(400).json({ success: false, message: `无法从内参文件名解析 role（head/right/left）：${f.originalname}` });
          }

          let intrinsicsObj = null;
          try {
            const raw = fs.readFileSync(finalPath, 'utf8');
            intrinsicsObj = JSON.parse(raw);
          } catch (e) {
            return res.status(400).json({ success: false, message: `内参 JSON 解析失败：${f.originalname}` });
          }

          const cameraId = await new Promise((resolve, reject) => {
            db.upsertCameraIntrinsics(
              {
                projectId,
                role,
                intrinsicsJson: intrinsicsObj,
                intrinsicsFilePath: finalPath,
                intrinsicsOriginalName: f.originalname,
                intrinsicsFileSize: f.size,
              },
              (err, id) => {
                if (err) return reject(err);
                resolve(id || null);
              },
            );
          });

          // 同步更新本次预加载缓存（同一批上传里，可能先 intrinsics 再 depth）
          try {
            if (cameraId) {
              cameraByRole.set(String(role).trim().toLowerCase(), { id: cameraId, role, intrinsics_file_path: finalPath });
            }
          } catch (_) {}

          files.push({
            id: null,
            filename: f.filename,
            originalName: f.originalname,
            size: f.size,
            url,
            role,
            modality,
            imageId: null,
            cameraId,
          });
          continue;
        }
      }

      // 严格模式：depth 文件必须能解析出 role，并且 (projectId, role) 必须在 cameras 表中存在
      if (depthFiles.length > 0) {
        const rolesNeeded = new Set();
        const roleMissingFiles = [];
        for (const f of depthFiles) {
          const r = inferRoleFromFilename(f.originalname);
          if (!r) roleMissingFiles.push(f.originalname);
          else rolesNeeded.add(String(r).trim().toLowerCase());
        }
        if (roleMissingFiles.length > 0) {
          deleteTempFiles(depthFiles);
          return res.status(400).json({
            success: false,
            message:
              `深度数据上传失败：无法从文件名解析相机 role（head/right/left）。\n` +
              `请确保文件名包含 head/left/right（例如 depth_head_0.png / depth_raw_head_0.npy）。\n\n` +
              `解析失败文件：\n- ${roleMissingFiles.join('\n- ')}`,
          });
        }

        const missingRoles = [];
        for (const r of rolesNeeded) {
          if (!cameraByRole.get(r)?.id) missingRoles.push(r);
        }
        if (missingRoles.length > 0) {
          deleteTempFiles(depthFiles);
          return res.status(400).json({
            success: false,
            message:
              `深度数据上传失败：项目 ${projectId} 缺少相机内参（cameras 表）记录，无法绑定 camera_id。\n` +
              `请先上传内参文件：intrinsics_<role>.json。\n\n` +
              `缺失 roles：\n- ${missingRoles.join('\n- ')}`,
          });
        }
      }

      for (const f of depthFiles) {
        // move to project depth dir
        const finalPath = path.join(projectDepthDir, f.filename);
        try {
          fs.renameSync(f.path, finalPath);
        } catch (moveErr) {
          console.error('移动 Depth 文件到项目目录失败:', moveErr);
          return res.status(500).json({ success: false, message: '移动深度文件到项目目录失败' });
        }

        const rel = path.relative(baseUploadsDir, finalPath).replace(/\\/g, '/');
        const url = `/uploads/${rel
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/')}`;

        const ext = String(path.extname(f.originalname || '')).toLowerCase();
        let modality = null;
        if (ext === '.png' || ext === '.tif' || ext === '.tiff') modality = 'depth_png';
        else if (ext === '.npy') modality = 'depth_raw';
        else if (ext === '.json') modality = 'intrinsics_json';

        let role = inferRoleFromFilename(f.originalname);
        role = role ? String(role).trim().toLowerCase() : null;
        const cameraId = role ? (cameraByRole.get(role)?.id ?? null) : null;

        // 这里不做兜底：上面已严格校验，缺失则直接 400
        console.log('[depth/upload][bindCamera]', {
          projectId,
          originalName: f.originalname,
          filename: f.filename,
          inferredRole: inferRoleFromFilename(f.originalname),
          finalRole: role || null,
          matchedCameraId: cameraId || null,
          camerasInProject: Array.from(cameraByRole.values()).map((c) => ({ id: c.id, role: c.role })),
        });

        const depthRecord = {
          projectId,
          imageId: resolvedImageIds.get(f.filename) || null,
          cameraId: cameraId || null,
          role,
          modality,
          filename: f.filename,
          originalName: f.originalname,
          path: finalPath,
          size: f.size,
          uploadTime: new Date().toISOString(),
        };

        const depthId = await new Promise((resolve, reject) => {
          db.insertDepthMap(depthRecord, (err, id) => {
            if (err) return reject(err);
            resolve(id);
          });
        });

        files.push({
          id: depthId,
          filename: f.filename,
          originalName: f.originalname,
          size: f.size,
          url,
          role,
          modality,
          imageId: depthRecord.imageId,
          cameraId: depthRecord.cameraId,
        });
      }

      return res.json({ success: true, files });
    } catch (error) {
      console.error('❌ /api/depth/upload 处理失败:', error);
      return res.status(500).json({ success: false, message: error?.message || '深度数据上传失败' });
    }
  });

  // 获取某个项目下的所有深度数据记录
  router.get('/', async (req, res) => {
    try {
      const projectIdRaw = req.query.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }

      const imageIdRaw = req.query.imageId;
      const imageId = imageIdRaw != null ? Number(imageIdRaw) : NaN;

      const formatRows = (rows) => {
        return (rows || []).map((row) => ({
          id: row.id,
          projectId: row.project_id,
          imageId: row.image_id,
          cameraId: row.camera_id,
          role: row.role,
          modality: row.modality,
          filename: row.filename,
          originalName: row.original_name,
          size: row.file_size,
          uploadTime: row.upload_time,
          url: buildImageUrl(row.file_path, row.filename),
        }));
      };

      const handler = async (err, rows) => {
        if (err) {
          console.error('查询 Depth 列表失败:', err);
          return res.status(500).json({ success: false, message: '查询 Depth 列表失败' });
        }

        // 兼容：intrinsics 已迁移到 cameras 表，但前端仍通过 depth 列表查找 intrinsics_*。
        // 这里把 cameras.intrinsics_* 虚拟成 depth 条目返回（modality='intrinsics'）。
        // 同时，若 depth_maps.camera_id 缺失，则按 (projectId, role) 回填一次，避免后续联表/过滤出现缺失。
        const cameras = await new Promise((resolve) => {
          db.listCamerasByProjectId(projectId, (cErr, cRows) => {
            if (cErr) return resolve([]);
            resolve(cRows || []);
          });
        });
        const cameraByRole = new Map();
        (cameras || []).forEach((c) => {
          const r = String(c?.role || '').trim().toLowerCase();
          if (!r) return;
          if (!cameraByRole.has(r)) cameraByRole.set(r, c);
        });

        // backfill camera_id for depth rows
        try {
          const depthRows = Array.isArray(rows) ? rows : [];
          const rolesNeeding = new Set();
          depthRows.forEach((d) => {
            const r = String(d?.role || '').trim().toLowerCase();
            const missing = d?.camera_id == null || Number(d.camera_id) === 0;
            if (r && missing && cameraByRole.get(r)?.id) rolesNeeding.add(r);
          });
          for (const r of rolesNeeding) {
            const cam = cameraByRole.get(r);
            if (!cam?.id) continue;
            db.backfillCameraIdByProjectAndRole(projectId, r, cam.id, () => {});
          }
        } catch (_) {}

        const depthOut = formatRows(rows);
        const intrOut = (cameras || [])
          .filter((c) => c?.intrinsics_file_path)
          .map((c) => ({
            id: null,
            projectId: c.project_id,
            imageId: imageId && !Number.isNaN(imageId) ? imageId : null,
            cameraId: c.id,
            role: c.role,
            modality: 'intrinsics',
            filename: path.basename(String(c.intrinsics_file_path || 'intrinsics.json')),
            originalName: c.intrinsics_original_name || path.basename(String(c.intrinsics_file_path || 'intrinsics.json')),
            size: c.intrinsics_file_size || null,
            uploadTime: c.updated_at || null,
            url: buildImageUrl(c.intrinsics_file_path, path.basename(String(c.intrinsics_file_path || 'intrinsics.json'))),
          }));

        return res.json({ success: true, depth: [...intrOut, ...depthOut] });
      };

      if (imageId && !Number.isNaN(imageId)) {
        db.getDepthMapsByImageId(projectId, imageId, (e, r) => handler(e, r));
      } else {
        db.getDepthMapsByProjectId(projectId, (e, r) => handler(e, r));
      }
    } catch (error) {
      console.error('❌ GET /api/depth 处理失败:', error);
      return res.status(500).json({ success: false, message: '获取 Depth 列表失败' });
    }
  });

  // cameras: list intrinsics by project
  router.get('/cameras', async (req, res) => {
    try {
      const projectIdRaw = req.query.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });

      db.listCamerasByProjectId(projectId, (err, rows) => {
        if (err) {
          console.error('查询 cameras 列表失败:', err);
          return res.status(500).json({ success: false, message: '查询 cameras 列表失败' });
        }
        const out = (rows || []).map((r) => {
          let intrinsics = null;
          try {
            intrinsics = r.intrinsics_json ? JSON.parse(r.intrinsics_json) : null;
          } catch (_) {
            intrinsics = null;
          }
          return {
            id: r.id,
            projectId: r.project_id,
            role: r.role,
            intrinsics,
            intrinsicsOriginalName: r.intrinsics_original_name,
            intrinsicsFileSize: r.intrinsics_file_size,
            updatedAt: r.updated_at,
          };
        });
        return res.json({ success: true, cameras: out });
      });
    } catch (error) {
      console.error('❌ GET /api/cameras 处理失败:', error);
      return res.status(500).json({ success: false, message: '获取 cameras 列表失败' });
    }
  });

  app.use('/api/depth', router);
  // 向后兼容：原来的 /api/cameras
  app.get('/api/cameras', (req, res, next) => {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    req.url = `/cameras${qs}`;
    router.handle(req, res, next);
  });
}

module.exports = { registerDepthRoutes };

