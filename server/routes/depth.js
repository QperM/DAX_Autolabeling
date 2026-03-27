const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const multer = require('multer');
const axios = require('axios');
const { getUploadsRootDir } = require('../utils/dataPaths');
const { debugLog } = require('../utils/debugSettingsStore');
const AdmZip = require('adm-zip');
const { path7za } = require('7zip-bin');

function createDepthUpload() {
  const depthStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = getUploadsRootDir();
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const original = String(file.originalname || 'depth.dat');
      const ext = (path.extname(original) || '').toLowerCase();
      const base = path.basename(original, ext || undefined).replace(/[^\w.\-() ]+/g, '_');
      // Deterministic filename: do not append timestamp/random suffix.
      cb(null, `${base}${ext || ''}`);
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
      // allow archives (depth only)
      if (ext === '.zip' || ext === '.7z') return cb(null, true);
      cb(new Error('仅支持深度图 PNG/TIFF、.npy 原始深度数据、intrinsics_*.json 相机内参，以及 .zip/.7z 压缩包'));
    },
  });
}

function registerDepthRoutes(app, { db, normalizeDepthKey, inferRoleFromFilename, buildImageUrl, depthRepairServiceUrl }) {
  const router = express.Router();
  const depthUpload = createDepthUpload();
  const isZipName = (name) => path.extname(name || '').toLowerCase() === '.zip';
  const is7zName = (name) => path.extname(name || '').toLowerCase() === '.7z';

  // archive internal rules (strict):
  // - depth PNG/TIFF: depth_*.png / depth_*.tif / depth_*.tiff
  // - depth raw: depth_raw_*.npy
  // - intrinsics: intrinsics_*.json
  function isAllowedDepthArchiveEntry(entryName) {
    const base = path.basename(String(entryName || '')).toLowerCase();
    const ext = path.extname(base);
    if (!['.png', '.tif', '.tiff', '.npy', '.json'].includes(ext)) return false;
    if (ext === '.json') return /^intrinsics_/i.test(base);
    if (ext === '.npy') return /^depth_raw_/i.test(base);
    // png/tif/tiff
    // exclude depth_raw_*.png by requiring depth_ not followed by raw_
    return /^depth_(?!raw_)/i.test(base);
  }

  function listZipFileEntries(zipPath) {
    const zip = new AdmZip(zipPath);
    return zip
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => String(e.entryName || '').replace(/\\/g, '/'))
      .filter(Boolean);
  }

  function list7zFileEntries(archivePath) {
    return new Promise((resolve, reject) => {
      const args = ['l', '-slt', archivePath];
      const p = spawn(path7za, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += String(d || '')));
      p.stderr.on('data', (d) => (stderr += String(d || '')));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(stderr || `7za list exit code ${code}`));

        const files = [];
        const blocks = stdout.split(/\r?\n\r?\n/);
        for (const b of blocks) {
          const lines = b.split(/\r?\n/).map((l) => l.trim());
          let pLine = null;
          let folder = null;
          let type = null;
          for (const line of lines) {
            if (line.startsWith('Path = ')) pLine = line.slice('Path = '.length);
            if (line.startsWith('Folder = ')) folder = line.slice('Folder = '.length);
            if (line.startsWith('Type = ')) type = line.slice('Type = '.length);
          }
          if (!pLine) continue;
          if (folder === '+') continue;
          // 7za -slt 会包含一条 “归档本身”的记录（Type = 7z）
          if (String(type || '').toLowerCase() === '7z') continue;
          if (pLine === path.basename(archivePath)) continue;
          files.push(String(pLine).replace(/\\/g, '/'));
        }
        resolve(files);
      });
    });
  }

  function run7zaExtract({ archivePath, outDir }) {
    return new Promise((resolve, reject) => {
      const args = ['x', archivePath, `-o${outDir}`, '-y', '-aoa'];
      const p = spawn(path7za, args, { windowsHide: true });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += String(d || '')));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(stderr || `7za exit code ${code}`));
      });
    });
  }

  async function expandDepthArchives(filesRaw) {
    const uploadedFiles = Array.isArray(filesRaw) ? filesRaw : [];
    const archives = [];
    const regular = [];
    for (const f of uploadedFiles) {
      const originalName = String(f?.originalname || '');
      if (isZipName(originalName) || is7zName(originalName)) archives.push(f);
      else regular.push(f);
    }

    if (archives.length === 0) return uploadedFiles;

    const expanded = [...regular];
    const tmpBase = path.join(os.tmpdir(), 'dax_depth_upload_extract');

    for (let aIdx = 0; aIdx < archives.length; aIdx++) {
      const archive = archives[aIdx];
      const archivePath = archive?.path;
      if (!archivePath) continue;

      const archiveName = String(archive?.originalname || '');
      const entries = isZipName(archiveName) ? listZipFileEntries(archivePath) : await list7zFileEntries(archivePath);

      const illegalEntries = entries.filter((e) => !isAllowedDepthArchiveEntry(e));
      if (illegalEntries.length > 0) {
        // strict: reject the whole request
        const show = illegalEntries.slice(0, 40).join('\n');
        const more = illegalEntries.length > 40 ? `\n（另外还有 ${illegalEntries.length - 40} 个未展示）` : '';
        const err = new Error(`深度压缩包包含非法文件，已拒绝本次上传。\n\n非法条目：\n${show}${more}`);
        err.code = 'DEPTH_UPLOAD_ILLEGAL_ARCHIVE_CONTENT';
        throw err;
      }

      if (entries.length === 0) {
        const err = new Error('深度压缩包为空或无法读取，已拒绝本次上传。');
        err.code = 'DEPTH_UPLOAD_ILLEGAL_ARCHIVE_CONTENT';
        throw err;
      }

      const tmpDir = path.join(tmpBase, `${Date.now()}_${Math.round(Math.random() * 1e9)}_${aIdx}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      // extract allowed entries
      if (isZipName(archiveName)) {
        const zip = new AdmZip(archivePath);
        const allowed = entries.filter((e) => isAllowedDepthArchiveEntry(e));
        for (let i = 0; i < allowed.length; i++) {
          const entryName = allowed[i];
          const entry = zip.getEntry(entryName);
          if (!entry) continue;
          const data = entry.getData();
          const baseName = path.basename(entryName);
          const ext = path.extname(baseName);
          const baseNoExt = path.basename(baseName, ext).replace(/[^\w.\-() ]+/g, '_');
          const filename = `__depth_zip_${aIdx}_${i}_${baseNoExt}${ext}`;
          const outPath = path.join(tmpDir, filename);
          fs.writeFileSync(outPath, data);

          const st = fs.statSync(outPath);
          expanded.push({
            originalname: entryName,
            filename,
            path: outPath,
            size: Number(st.size || 0),
          });
        }
      } else {
        // 7z
        const allowed = entries.filter((e) => isAllowedDepthArchiveEntry(e));
        await run7zaExtract({ archivePath, outDir: tmpDir });
        for (let i = 0; i < allowed.length; i++) {
          const entryName = allowed[i];
          const extractedPath = path.join(tmpDir, ...String(entryName).split('/'));
          if (!fs.existsSync(extractedPath)) continue;
          const st = fs.statSync(extractedPath);
          const baseName = path.basename(entryName);
          const ext = path.extname(baseName);
          const baseNoExt = path.basename(baseName, ext).replace(/[^\w.\-() ]+/g, '_');
          const filename = `__depth_7z_${aIdx}_${i}_${baseNoExt}${ext}`;
          expanded.push({
            originalname: entryName,
            filename,
            path: extractedPath,
            size: Number(st.size || 0),
          });
        }
      }

      // cleanup archive file itself (uploaded temp)
      try {
        fs.unlinkSync(archivePath);
      } catch (_) {}
    }

    return expanded;
  }

  const extractImageSequenceToken = (img) => {
    const candidates = [
      img?.original_name,
      img?.filename,
      img?.file_path ? path.basename(String(img.file_path)) : null,
    ].filter(Boolean);
    for (const raw of candidates) {
      const noExt = path.basename(String(raw), path.extname(String(raw)));
      // Keep the right-most numeric token as-is (preserve zero-padding, e.g. 012)
      const m = noExt.match(/(\d+)(?!.*\d)/);
      if (m?.[1]) return m[1];
    }
    return String(Number(img?.id || 0) || 0);
  };

  // 上传深度图 / 深度原始数据 / intrinsics_*.json
  router.post('/upload', depthUpload.array('depthFiles', 2000), async (req, res) => {
    try {
      debugLog('node', 'node9DDepthUpload', {
        stage: 'received',
        filesCount: Array.isArray(req.files) ? req.files.length : 0,
        projectId: req.body?.projectId ?? null,
      });
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

      const baseUploadsDir = getUploadsRootDir();
      const projectDepthDir = path.join(baseUploadsDir, `project_${projectId}`, 'depth');
      if (!fs.existsSync(projectDepthDir)) {
        fs.mkdirSync(projectDepthDir, { recursive: true });
      }

      // 预加载该项目下的所有图片，用于按 RGB 文件名 key 绑定 image_id
      const projectImages = await new Promise((resolve, reject) => {
        db.getImagesByProjectId(projectId, (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        });
      });

      // 预构建项目中所有 RGB 图片的 key -> imageId 映射
      const imageKeyMap = new Map();
      projectImages.forEach((img) => {
        const keys = [img.original_name, img.filename, img.file_path ? path.basename(String(img.file_path)) : null].filter(Boolean);
        const seen = new Set();
        keys.forEach((raw) => {
          const key = normalizeDepthKey(raw);
          if (!key || seen.has(key)) return;
          seen.add(key);
          if (!imageKeyMap.has(key)) imageKeyMap.set(key, img.id);
        });
      });

      const findImageIdForDepth = (origName) => {
        const key = normalizeDepthKey(origName);
        if (!key) return null;
        return imageKeyMap.get(key) || null;
      };

      let filesRaw = req.files || [];
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

      // Expand depth zip/7z archives (strict validation + reject with rollback).
      // After expansion, `filesRaw` contains only:
      // - regular depth/intrinsics files uploaded directly
      // - extracted archive internal files (only depth + intrinsics)
      try {
        filesRaw = await expandDepthArchives(filesRaw);
      } catch (e) {
        // rollback: delete all uploaded temp files (including archives)
        deleteTempFiles(req.files || []);
        return res.status(400).json({
          success: false,
          message: e?.message || '深度压缩包上传失败',
        });
      }

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
        const mismatchMessage =
          `深度数据与当前项目 RGB 图片不匹配，请检查后重试。\n\n` +
          `命名要求（key 必须一致）：\n` +
          `- rgb_<key>.<ext>\n` +
          `- depth_<key>.png\n` +
          `- depth_raw_<key>.npy\n\n` +
          `未匹配文件：\n- ${unmatched.join('\n- ')}`;
        debugLog('node', 'node9DDepthUpload', {
          stage: 'rejected-unmatched-rgb',
          projectId,
          unmatchedCount: unmatched.length,
          unmatched: unmatched.slice(0, 20),
        });
        return res.status(400).json({
          success: false,
          code: 'DEPTH_RGB_MISMATCH',
          message: mismatchMessage,
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
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
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
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
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
        debugLog('node', 'nodeDepthMatch', {
          projectId,
          clientOriginalName: f.originalname,
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
          size: f.size,
          url,
          role,
          modality,
          imageId: depthRecord.imageId,
          cameraId: depthRecord.cameraId,
        });
      }

      debugLog('node', 'node9DDepthUpload', {
        stage: 'completed',
        projectId,
        savedCount: files.length,
      });
      return res.json({ success: true, files });
    } catch (error) {
      console.error('❌ /api/depth/upload 处理失败:', error);
      debugLog('node', 'node9DDepthUpload', {
        stage: 'error',
        message: error?.message || String(error),
      });
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
          size: row.file_size,
          uploadTime: row.upload_time,
          url: buildImageUrl(row.file_path, row.filename),
          depthRawFixPath: row.depth_raw_fix_path || null,
          depthPngFixPath: row.depth_png_fix_path || null,
          depthRawFixUrl: row.depth_raw_fix_path
            ? buildImageUrl(row.depth_raw_fix_path, path.basename(String(row.depth_raw_fix_path)))
            : null,
          depthPngFixUrl: row.depth_png_fix_path
            ? buildImageUrl(row.depth_png_fix_path, path.basename(String(row.depth_png_fix_path)))
            : null,
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

  // 批量补全深度信息：调用 depthrepair-service 推理并回写 *_fix 路径
  router.post('/repair/batch', async (req, res) => {
    try {
      debugLog('node', 'nodeDepthRepairRequest', {
        stage: 'received',
        projectId: req.body?.projectId ?? null,
      });
      const projectIdRaw = req.body?.projectId;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }

      const images = await new Promise((resolve, reject) => {
        db.getImagesByProjectId(projectId, (err, rows) => {
          if (err) return reject(err);
          return resolve(Array.isArray(rows) ? rows : []);
        });
      });
      const cameras = await new Promise((resolve) => {
        db.listCamerasByProjectId(projectId, (err, rows) => {
          if (err) return resolve([]);
          return resolve(Array.isArray(rows) ? rows : []);
        });
      });
      const cameraByRole = new Map();
      for (const c of cameras) {
        const r = String(c?.role || '').trim().toLowerCase();
        if (!r) continue;
        if (c?.intrinsics_file_path) cameraByRole.set(r, c);
      }

      const projectDepthDir = path.join(getUploadsRootDir(), `project_${projectId}`, 'depth');
      if (!fs.existsSync(projectDepthDir)) {
        fs.mkdirSync(projectDepthDir, { recursive: true });
      }

      let upserted = 0;
      /** 仅统计「至少有一条成功」的图像 id（避免 upserted 按 role 累计被当成「张数」） */
      const repairedImageIds = new Set();
      let skipped = 0;
      let failed = 0;
      const failedDetails = [];

      for (const img of images) {
        try {
          const rgbPath = img?.file_path || null;
          if (!rgbPath || !fs.existsSync(rgbPath)) {
            skipped += 1;
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const depthRows = await new Promise((resolve, reject) => {
            db.getDepthMapsByImageId(projectId, img.id, (err, rows) => {
              if (err) return reject(err);
              return resolve(Array.isArray(rows) ? rows : []);
            });
          });

          const byRole = new Map();
          for (const row of depthRows) {
            const role = String(row?.role || 'head').trim().toLowerCase();
            if (!byRole.has(role)) byRole.set(role, []);
            byRole.get(role).push(row);
          }

          if (byRole.size === 0) {
            skipped += 1;
            continue;
          }

          for (const [role, rows] of byRole.entries()) {
            const depthRaw = rows.find(
              (d) => d?.modality === 'depth_raw' || String(d?.filename || '').toLowerCase().endsWith('.npy'),
            );
            const depthPng = rows.find(
              (d) => d?.modality === 'depth_png' || String(d?.filename || '').toLowerCase().endsWith('.png'),
            );

            const depthRawPath = depthRaw?.file_path || null;
            const depthPngPath = depthPng?.file_path || null;
            const intrinsicsPath = cameraByRole.get(String(role).trim().toLowerCase())?.intrinsics_file_path || null;
            const depthInputPath =
              depthRawPath && fs.existsSync(depthRawPath)
                ? depthRawPath
                : depthPngPath && fs.existsSync(depthPngPath)
                  ? depthPngPath
                  : null;
            if (!depthInputPath) {
              skipped += 1;
              continue;
            }
            if (!intrinsicsPath) {
              failed += 1;
              failedDetails.push(`[${img.original_name || img.filename}][${role}] 缺少 intrinsics`);
              continue;
            }

            const safeRole = String(role || 'head').replace(/[^\w\-]/g, '_');
            const imageSeqToken = extractImageSequenceToken(img);
            const depthRawFixPath = path.join(projectDepthDir, `depth_raw_fix_${safeRole}_${imageSeqToken}.npy`);
            const depthPngFixPath = path.join(projectDepthDir, `depth_fix_${safeRole}_${imageSeqToken}.png`);

            try {
              debugLog('node', 'nodeDepthRepairRequest', {
                stage: 'per-image-role',
                projectId,
                imageId: img.id,
                role,
              });
              // eslint-disable-next-line no-await-in-loop
              await axios.post(
                `${String(depthRepairServiceUrl || 'http://localhost:7870').replace(/\/+$/, '')}/api/repair-depth`,
                {
                  rgbPath,
                  depthPath: depthInputPath,
                  intrinsicsPath,
                  imageId: img.id,
                  imageOriginalName: img.original_name || img.filename,
                  outputDepthNpyPath: depthRawFixPath,
                  outputDepthPngPath: depthPngFixPath,
                  device: 'auto',
                  noMask: false,
                  depthPngScale: 1000,
                },
                { timeout: 10 * 60 * 1000 },
              );

              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve, reject) => {
                db.updateDepthFixPathsByProjectImageRole(
                  projectId,
                  img.id,
                  role,
                  depthRawFixPath,
                  depthPngFixPath,
                  (err) => (err ? reject(err) : resolve(null)),
                );
              });

              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve, reject) => {
                db.upsertDepthRepairRecord(
                  {
                    projectId,
                    imageId: img.id,
                    role,
                    depthRawPath,
                    depthPngPath,
                    depthRawFixPath,
                    depthPngFixPath,
                    status: 'done',
                    note: null,
                  },
                  (err) => (err ? reject(err) : resolve(null)),
                );
              });
              upserted += 1;
              repairedImageIds.add(Number(img.id));
            } catch (e) {
              failed += 1;
              failedDetails.push(
                `[${img.original_name || img.filename}][${role}] ${e?.response?.data?.detail || e?.response?.data?.message || e?.message || 'repair failed'}`,
              );
              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve) => {
                db.upsertDepthRepairRecord(
                  {
                    projectId,
                    imageId: img.id,
                    role,
                    depthRawPath,
                    depthPngPath,
                    depthRawFixPath,
                    depthPngFixPath,
                    status: 'failed',
                    note: String(e?.response?.data?.detail || e?.message || 'repair failed'),
                  },
                  () => resolve(null),
                );
              });
            }
          }
        } catch (e) {
          failed += 1;
        }
      }

      const payload = {
        success: true,
        projectId,
        totalImages: images.length,
        /** 成功写入的 depth 条目数（按 project+image+role 计，多角色时可能 > 图像数） */
        upserted,
        /** 至少有一条深度条目成功写入的图像张数 */
        repairedImages: repairedImageIds.size,
        skipped,
        failed,
        failedDetails,
      };
      debugLog('node', 'nodeDepthRepairResult', {
        stage: 'completed',
        projectId,
        totalImages: payload.totalImages,
        repairedImages: payload.repairedImages,
        failed: payload.failed,
      });
      return res.json(payload);
    } catch (error) {
      console.error('❌ /api/depth/repair/batch 处理失败:', error);
      debugLog('node', 'nodeDepthRepairResult', {
        stage: 'error',
        message: error?.message || String(error),
      });
      return res.status(500).json({ success: false, message: error?.message || '批量补全深度信息失败' });
    }
  });

  // 批量补全深度的进行中进度（轮询）
  // 说明：/repair/batch 是同步长任务，但 depth_repair_records 会在执行过程中逐步写入，
  // 因此可以通过 updated_at + sinceMs 统计“本次批量”已处理过的图像数量。
  router.get('/repair/batch/status', async (req, res) => {
    try {
      const projectIdRaw = req.query?.projectId;
      const sinceMsRaw = req.query?.sinceMs;
      const projectId = projectIdRaw != null ? Number(projectIdRaw) : NaN;
      const sinceMs = sinceMsRaw != null ? Number(sinceMsRaw) : NaN;

      if (!projectId || Number.isNaN(projectId)) {
        return res.status(400).json({ success: false, message: '缺少或非法的 projectId' });
      }
      if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
        return res.status(400).json({ success: false, message: '缺少或非法的 sinceMs' });
      }

      const sinceIso = new Date(sinceMs).toISOString();

      const totalImages = await new Promise((resolve, reject) => {
        db.countImagesByProjectId(projectId, (err, cnt) => {
          if (err) return reject(err);
          return resolve(Number(cnt || 0));
        });
      });

      const progress = await new Promise((resolve, reject) => {
        db.getDepthRepairBatchProgressBySince(projectId, sinceIso, (err, row) => {
          if (err) return reject(err);
          return resolve(row || { doneImages: 0, failedImages: 0, processedImages: 0 });
        });
      });

      const processedImages = Number(progress?.processedImages || 0);
      const doneImages = Number(progress?.doneImages || 0);
      const failedImages = Number(progress?.failedImages || 0);

      return res.json({
        success: true,
        projectId,
        totalImages,
        processedImages,
        doneImages,
        failedImages,
      });
    } catch (error) {
      debugLog('node', 'nodeDepthRepairResult', {
        message: error?.message || String(error),
      });
      // 保留错误信息给客户端（同时可通过调试面板打开 debugLog 获取更多细节）
      return res.status(500).json({ success: false, message: error?.message || '获取进度失败' });
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

