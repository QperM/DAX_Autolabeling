const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getUploadsRootDir } = require('../utils/dataPaths');
const { debugLog } = require('../utils/debugSettingsStore');

function registerMeshRoutes(app, { db, computeObjBoundingBox, buildImageUrl, buildUploadsDirUrl }) {
  const router = express.Router();

  // Mesh upload storage（先落盘到 uploads 根目录，后续移动到项目目录）
  const meshStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = getUploadsRootDir();
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const original = String(file.originalname || 'mesh.obj');
      const ext = (path.extname(original) || '.obj').toLowerCase();
      const base = path.basename(original, path.extname(original) || ext).replace(/[^\w.\-() ]+/g, '_');
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${base}-${uniqueSuffix}${ext}`);
    },
  });

  const meshUpload = multer({
    storage: meshStorage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 单个 OBJ 默认 200MB
    fileFilter: (req, file, cb) => {
      const ext = String(path.extname(file.originalname || '')).toLowerCase();
      const allowed = new Set(['.obj', '.mtl', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.gif']);
      if (allowed.has(ext)) return cb(null, true);
      cb(new Error(`不支持的 Mesh 资源类型: ${ext || '(无扩展名)'}；请上传 .obj/.mtl 及贴图图片`));
    },
  });

  router.post('/upload', meshUpload.array('meshes', 50), async (req, res) => {
    try {
      debugLog('node', 'node9DMeshUpload', {
        stage: 'received',
        filesCount: Array.isArray(req.files) ? req.files.length : 0,
        projectId: req.body?.projectId ?? null,
      });
      const projectIdRaw = req.body?.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }

      const baseUploadsDir = getUploadsRootDir();
      const projectMeshDir = path.join(baseUploadsDir, `project_${projectId}`, 'meshes');
      if (!fs.existsSync(projectMeshDir)) {
        fs.mkdirSync(projectMeshDir, { recursive: true });
      }

      const filesRaw = req.files || [];
      const files = [];

      // 每次上传创建一个 pack 目录，确保 OBJ/MTL/贴图在同一目录
      const packId = `pack_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
      const packDir = path.join(projectMeshDir, packId);
      if (!fs.existsSync(packDir)) {
        fs.mkdirSync(packDir, { recursive: true });
      }

      for (const f of filesRaw) {
        const original = String(f.originalname || f.filename || 'asset').replace(/\\/g, '/').split('/').pop();
        const ext = String(path.extname(original || '')).toLowerCase();
        const base = path
          .basename(original || f.filename, path.extname(original || f.filename))
          .replace(/[^\w.\-() ]+/g, '_')
          .trim();
        const finalName = `${base || 'asset'}${ext || ''}`;
        const finalPath = path.join(packDir, finalName);
        try {
          fs.renameSync(f.path, finalPath);
        } catch (moveErr) {
          console.error('移动 Mesh 文件到项目目录失败，仍使用原路径:', moveErr);
        }

        const rel = path.relative(baseUploadsDir, finalPath).replace(/\\/g, '/');
        const url = `/uploads/${rel
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/')}`;

        // 只对 .obj 入库
        if (ext === '.obj') {
          let bbox = null;
          try {
            bbox = await computeObjBoundingBox(finalPath);
          } catch (e) {
            console.warn('[meshes/upload] 计算 OBJ bounding box 失败（忽略，仍入库）:', e?.message || e);
            bbox = null;
          }
          const meshRecord = {
            projectId,
            filename: finalName,
            originalName: original,
            path: finalPath,
            size: f.size,
            bboxJson: bbox ? JSON.stringify(bbox) : null,
            uploadTime: new Date().toISOString(),
          };

          try {
            await new Promise((resolve, reject) => {
              db.insertMesh(meshRecord, (err, meshId) => {
                if (err) return reject(err);
                files.push({
                  id: meshId,
                  filename: finalName,
                  originalName: original,
                  size: f.size,
                  url,
                  bbox,
                });
                resolve();
              });
            });
          } catch (e) {
            console.error('插入 Mesh 记录失败:', e);
            files.push({
              filename: finalName,
              originalName: original,
              size: f.size,
              url,
              bbox,
            });
          }
        }
      }

      debugLog('node', 'node9DMeshUpload', {
        stage: 'completed',
        projectId,
        savedMeshes: files.length,
      });
      return res.json({ success: true, files });
    } catch (error) {
      console.error('❌ /api/meshes/upload 处理失败:', error);
      debugLog('node', 'node9DMeshUpload', {
        stage: 'error',
        message: error?.message || String(error),
      });
      return res.status(500).json({ success: false, message: error?.message || 'Mesh 上传失败' });
    }
  });

  router.get('/', async (req, res) => {
    try {
      const projectIdRaw = req.query.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }

      db.getMeshesByProjectId(projectId, (err, rows) => {
        if (err) {
          console.error('查询 Mesh 列表失败:', err);
          return res.status(500).json({ success: false, message: '查询 Mesh 列表失败' });
        }

        const meshes = (rows || []).map((row) => ({
          id: row.id,
          projectId: row.project_id,
          filename: row.filename,
          originalName: row.original_name,
          size: row.file_size,
          uploadTime: row.upload_time,
          skuLabel: row.sku_label || null,
          bbox: (() => {
            try {
              return row.bbox_json ? JSON.parse(row.bbox_json) : null;
            } catch (_) {
              return null;
            }
          })(),
          url: buildImageUrl(row.file_path, row.filename),
          assetDirUrl: buildUploadsDirUrl(path.dirname(row.file_path || '')),
          assets: (() => {
            try {
              const dir = path.dirname(row.file_path || '');
              if (!dir || !fs.existsSync(dir)) return [];
              const names = fs.readdirSync(dir).filter((n) => typeof n === 'string');
              return names.filter((n) => /\.(mtl|png|jpg|jpeg|webp|bmp|tga|gif|obj)$/i.test(n));
            } catch (_) {
              return [];
            }
          })(),
        }));

        return res.json({ success: true, meshes });
      });
    } catch (error) {
      console.error('❌ GET /api/meshes 处理失败:', error);
      return res.status(500).json({ success: false, message: '获取 Mesh 列表失败' });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const meshId = Number(req.params.id);
      if (!meshId || Number.isNaN(meshId)) {
        return res.status(400).json({ success: false, message: '非法的 meshId' });
      }
      const skuLabel = req.body?.skuLabel ?? null;

      const meshRow = await new Promise((resolve, reject) => {
        db.getMeshById(meshId, (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        });
      });
      if (!meshRow) {
        return res.status(404).json({ success: false, message: 'Mesh 不存在' });
      }

      const projectId = meshRow.project_id;
      if (!(req.session && req.session.isAdmin)) {
        const sessionId = req.sessionID;
        const hasAccess = await db.hasProjectAccess(sessionId, projectId);
        if (!hasAccess) {
          return res.status(403).json({ success: false, message: '没有访问该项目的权限，请先输入验证码' });
        }
      }

      const changes = await new Promise((resolve, reject) => {
        db.updateMeshSkuLabel(meshId, skuLabel, (err, ch) => {
          if (err) return reject(err);
          resolve(ch || 0);
        });
      });

      return res.json({ success: true, changes, message: 'Mesh 已更新' });
    } catch (error) {
      console.error('❌ PUT /api/meshes/:id 处理失败:', error);
      return res.status(500).json({ success: false, message: '更新 Mesh 失败', error: error?.message || String(error) });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const meshId = Number(req.params.id);
      if (!meshId || Number.isNaN(meshId)) {
        return res.status(400).json({ success: false, message: '非法的 meshId' });
      }

      const meshRow = await new Promise((resolve, reject) => {
        db.getMeshById(meshId, (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        });
      });

      if (!meshRow) {
        return res.status(404).json({ success: false, message: 'Mesh 不存在' });
      }

      const projectId = meshRow.project_id;
      if (!(req.session && req.session.isAdmin)) {
        const sessionId = req.sessionID;
        const hasAccess = await db.hasProjectAccess(sessionId, projectId);
        if (!hasAccess) {
          return res.status(403).json({ success: false, message: '没有访问该项目的权限，请先输入验证码' });
        }
      }

      await new Promise((resolve, reject) => {
        db.deletePose9DByMeshId(meshId, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      try {
        const fp = meshRow.file_path;
        if (fp) {
          const dir = path.dirname(fp);
          if (dir && fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          } else if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
          }
        }
      } catch (e) {
        console.warn('[DELETE /api/meshes/:id] 删除物理文件失败（继续删除 DB 记录）:', e);
      }

      const changes = await new Promise((resolve, reject) => {
        db.deleteMeshById(meshId, (err, ch) => {
          if (err) return reject(err);
          resolve(ch || 0);
        });
      });

      return res.json({ success: true, changes, message: 'Mesh 已删除' });
    } catch (error) {
      console.error('❌ DELETE /api/meshes/:id 处理失败:', error);
      return res.status(500).json({ success: false, message: '删除 Mesh 失败', error: error?.message || String(error) });
    }
  });

  app.use('/api/meshes', router);
}

module.exports = { registerMeshRoutes };

