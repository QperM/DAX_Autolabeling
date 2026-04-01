const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { path7za } = require('7zip-bin');
const { buildImageUrl } = require('../utils/uploads');
const { debugLog } = require('../utils/debugSettingsStore');

function registerUploadRoutes(app, { db, upload, getProjectUploadDir }) {
  const router = express.Router();

  // ZIP 解压进度 job（内存态：重启会丢失，够用来显示进度）
  // job = { id, status, message, zipOriginalName, total, processed, files: Image[], error? }
  const uploadJobs = new Map();

  function makeJobId() {
    return `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  }

  function getIsImageFile(name) {
    const ext = (path.extname(name || '').toLowerCase() || '').replace('.', '');
    return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'tif', 'webp'].includes(ext);
  }

  function isZipName(name) {
    return path.extname(name || '').toLowerCase() === '.zip';
  }

  function is7zName(name) {
    return path.extname(name || '').toLowerCase() === '.7z';
  }

  function safeUnlink(filePath) {
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }

  function makeIllegalItem(containerName, innerPath) {
    return {
      container: containerName || null, // null 表示直接上传的单文件
      path: String(innerPath || ''),
    };
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
          // 7za -slt 会包含一条 “归档本身” 的记录（Type = 7z，Path = <archive>），不能当成内部文件
          if (String(type || '').toLowerCase() === '7z') continue;
          if (pLine === path.basename(archivePath)) continue;
          files.push(String(pLine).replace(/\\/g, '/'));
        }
        resolve(files);
      });
    });
  }

  async function validateIncomingUploadOrThrow(files) {
    const illegal = [];

    for (const f of files) {
      const original = String(f.originalname || '');
      const isDirectImage = getIsImageFile(original);
      const isZip = isZipName(original);
      const is7z = is7zName(original);

      // 允许：直接图片 / zip / 7z（压缩包内必须全是图片）
      if (!isDirectImage && !isZip && !is7z) {
        illegal.push(makeIllegalItem(null, original));
        continue;
      }

      if (isZip) {
        const entries = listZipFileEntries(f.path);
        const bad = entries.filter((p) => !getIsImageFile(p));
        bad.forEach((p) => illegal.push(makeIllegalItem(original, p)));
      }

      if (is7z) {
        const entries = await list7zFileEntries(f.path);
        const bad = entries.filter((p) => !getIsImageFile(p));
        bad.forEach((p) => illegal.push(makeIllegalItem(original, p)));
      }
    }

    if (illegal.length > 0) {
      const MAX_SHOW = 40;
      const preview = illegal.slice(0, MAX_SHOW);
      const more = illegal.length > MAX_SHOW ? `（另外还有 ${illegal.length - MAX_SHOW} 个未展示）` : '';
      const desc =
        preview
          .map((it) => (it.container ? `${it.container} -> ${it.path}` : `${it.path}`))
          .join('\n') + (more ? `\n${more}` : '');

      const err = new Error(
        `上传内容不合规：只允许上传常见图片（png/jpg/jpeg/webp/gif/bmp/tiff）。\n` +
          `压缩包内也必须全部为图片；发现以下非法条目：\n\n${desc}`
      );
      err.code = 'UPLOAD_CONTAINS_NON_IMAGE';
      err.illegal = illegal;
      throw err;
    }
  }

  function finalizeUploadedRgb(imageId, projectId, fileInfo) {
    return new Promise((resolve) => {
      db.finalizeRgbImageStorage(imageId, projectId, fileInfo.originalName, fileInfo.path, (err, meta) => {
        if (err) console.error('[upload] finalizeRgbImageStorage:', err);
        if (meta) {
          fileInfo.filename = meta.filename;
          fileInfo.path = meta.path;
          fileInfo.url = buildImageUrl(meta.path, meta.filename);
        }
        resolve();
      });
    });
  }

  function insertImageAsync(fileInfo) {
    return new Promise((resolve, reject) => {
      db.insertImage(fileInfo, (err, imageId) => {
        if (err) return reject(err);
        resolve(imageId);
      });
    });
  }

  function linkImageToProjectAsync(projectId, imageId) {
    return new Promise((resolve) => {
      if (!projectId) return resolve();
      db.linkImageToProject(projectId, imageId, (err) => {
        if (err) console.error('关联图片到项目失败:', err);
        resolve();
      });
    });
  }

  function getProjectImagesDir(projectId) {
    if (!projectId) return getProjectUploadDir(projectId);
    const imagesDir = path.join(getProjectUploadDir(projectId), 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    return imagesDir;
  }

  function safeRmDir(dirPath) {
    if (!dirPath) return;
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_) {}
  }

  function listFilesRecursive(rootDir) {
    const out = [];
    const stack = [rootDir];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur) continue;
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const ent of entries) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile()) {
          out.push(full);
        }
      }
    }
    return out;
  }

  function run7zaExtract({ archivePath, outDir }) {
    return new Promise((resolve, reject) => {
      const args = ['x', archivePath, `-o${outDir}`, '-y', '-aoa'];
      const p = spawn(path7za, args, { windowsHide: true });
      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += String(d || '');
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new Error(stderr || `7za exit code ${code}`));
      });
    });
  }

  async function run7zExtractJob({ jobId, archivePath, archiveOriginalName, projectId }) {
    const job = uploadJobs.get(jobId);
    if (!job) return;

    job.status = 'extracting';
    job.message = '正在解压...';

    const uploadDir = getProjectImagesDir(projectId);
    const tmpBase = path.join(os.tmpdir(), 'dax_upload_extract');
    const tmpDir = path.join(tmpBase, `${jobId}_${Date.now()}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      await run7zaExtract({ archivePath, outDir: tmpDir });

      const allFiles = listFilesRecursive(tmpDir);
      // 严格限制：解压出来的文件必须全部是图片（否则拒绝整批）
      const nonImageFiles = allFiles.filter((p) => !getIsImageFile(p));
      if (nonImageFiles.length > 0) {
        const show = nonImageFiles
          .slice(0, 40)
          .map((p) => path.relative(tmpDir, p).replace(/\\/g, '/'))
          .join('\n');
        const more = nonImageFiles.length > 40 ? `\n（另外还有 ${nonImageFiles.length - 40} 个未展示）` : '';
        throw new Error(`压缩包包含非图片文件，已拒绝本次上传：\n${show}${more}`);
      }

      const imageFiles = allFiles.filter((p) => getIsImageFile(p)).slice(0, 2000);

      const MAX_TOTAL_UNCOMPRESSED = 3 * 1024 * 1024 * 1024; // 3GB
      let totalBytes = 0;
      for (const p of imageFiles) {
        const st = fs.statSync(p);
        totalBytes += Number(st.size || 0);
        if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
          throw new Error('压缩包内容过大（解压后体积超过限制），请拆分后再上传');
        }
      }

      job.total = imageFiles.length;
      job.processed = 0;
      job.files = [];

      if (job.total === 0) {
        job.status = 'completed';
        job.message = '压缩包中未找到可用图片';
        return;
      }

      for (const filePath of imageFiles) {
        const dotExt = path.extname(filePath || '').toLowerCase() || '.png';
        const staging = `__7z_${job.processed}_${Math.round(Math.random() * 1e9)}${dotExt}`;
        const outPath = path.join(uploadDir, staging);

        try {
          if (fs.existsSync(outPath)) {
            try {
              fs.unlinkSync(outPath);
            } catch (_) {}
          }
          fs.renameSync(filePath, outPath);
        } catch (_) {
          // fallback: copy
          fs.copyFileSync(filePath, outPath);
        }

        const st = fs.statSync(outPath);
        const originalName = path.basename(filePath);

        const fileInfo = {
          filename: staging,
          originalName,
          path: outPath,
          url: buildImageUrl(outPath, staging),
          size: Number(st.size || 0),
          uploadTime: new Date().toISOString(),
        };

        const imageId = await insertImageAsync(fileInfo);
        await linkImageToProjectAsync(projectId, imageId);
        await finalizeUploadedRgb(imageId, projectId, fileInfo);
        fileInfo.id = imageId;

        job.files.push(fileInfo);
        job.processed += 1;
        job.message = `正在解压... (${job.processed}/${job.total})`;
      }

      job.status = 'completed';
      job.message = '解压完成';
    } catch (e) {
      console.error('[7Z] 解压失败:', e);
      job.status = 'error';
      job.error = e?.message || String(e);
      job.message = '解压失败';
    } finally {
      safeRmDir(tmpDir);
      try {
        fs.unlinkSync(archivePath);
      } catch (_) {}
    }
  }

  async function runZipExtractJob({ jobId, zipPath, zipOriginalName, projectId }) {
    const job = uploadJobs.get(jobId);
    if (!job) return;

    job.status = 'extracting';
    job.message = '正在解压...';

    const uploadDir = getProjectImagesDir(projectId);
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);

      // 严格限制：压缩包内必须全部是图片（否则拒绝整批）
      const illegalEntries = entries
        .map((e) => String(e.entryName || '').replace(/\\/g, '/'))
        .filter(Boolean)
        .filter((p) => !getIsImageFile(p));
      if (illegalEntries.length > 0) {
        const show = illegalEntries.slice(0, 40).join('\n');
        const more = illegalEntries.length > 40 ? `\n（另外还有 ${illegalEntries.length - 40} 个未展示）` : '';
        throw new Error(`压缩包包含非图片文件，已拒绝本次上传：\n${show}${more}`);
      }

      const MAX_FILES = 2000;
      const MAX_TOTAL_UNCOMPRESSED = 3 * 1024 * 1024 * 1024; // 3GB

      const imageEntries = entries.filter((e) => getIsImageFile(e.entryName)).slice(0, MAX_FILES);
      let totalBytes = 0;
      for (const e of imageEntries) {
        const size = Number(e.header?.size || 0);
        totalBytes += size;
        if (totalBytes > MAX_TOTAL_UNCOMPRESSED) {
          throw new Error('压缩包内容过大（解压后体积超过限制），请拆分后再上传');
        }
      }

      job.total = imageEntries.length;
      job.processed = 0;
      job.files = [];

      if (job.total === 0) {
        job.status = 'completed';
        job.message = '压缩包中未找到可用图片';
        return;
      }

      for (const entry of imageEntries) {
        const dotExt = path.extname(entry.entryName || '').toLowerCase() || '.png';
        const staging = `__zip_${job.processed}_${Math.round(Math.random() * 1e9)}${dotExt}`;
        const outPath = path.join(uploadDir, staging);

        const data = entry.getData();
        fs.writeFileSync(outPath, data);

        const originalName = String(entry.entryName || `image${dotExt}`).replace(/\\/g, '/');

        const fileInfo = {
          filename: staging,
          originalName,
          path: outPath,
          url: buildImageUrl(outPath, staging),
          size: data.length,
          uploadTime: new Date().toISOString(),
        };

        const imageId = await insertImageAsync(fileInfo);
        await linkImageToProjectAsync(projectId, imageId);
        await finalizeUploadedRgb(imageId, projectId, fileInfo);
        fileInfo.id = imageId;

        job.files.push(fileInfo);
        job.processed += 1;
        job.message = `正在解压... (${job.processed}/${job.total})`;
      }

      job.status = 'completed';
      job.message = '解压完成';
    } catch (e) {
      console.error('[ZIP] 解压失败:', e);
      job.status = 'error';
      job.error = e?.message || String(e);
      job.message = '解压失败';
    } finally {
      try {
        fs.unlinkSync(zipPath);
      } catch (_) {}
    }
  }

  async function runDirectImagesProcessJob({ jobId, files, projectId }) {
    const job = uploadJobs.get(jobId);
    if (!job) return;

    job.status = 'processing';
    job.total = files.length;
    job.processed = 0;
    job.message = '等待入库...';
    job.files = [];
    job.failed = 0;

    const projectIdNum = projectId != null ? Number(projectId) : null;

    try {
      for (const file of files) {
        try {
          // 普通图片：移动到项目 images 目录（如果提供 projectId）
          let finalPath = file.path;
          if (projectIdNum) {
            const projectDir = getProjectImagesDir(projectIdNum);
            const finalFilename = path.basename(file.path);
            finalPath = path.join(projectDir, finalFilename);

            try {
              if (fs.existsSync(finalPath)) {
                safeUnlink(finalPath);
              }
              fs.renameSync(file.path, finalPath);
            } catch (err) {
              console.error('[upload][ingest] 移动文件到项目文件夹失败:', err);
              finalPath = file.path;
            }
          }

          const fileInfo = {
            filename: path.basename(finalPath),
            originalName: file.originalname,
            path: finalPath,
            url: buildImageUrl(finalPath, path.basename(finalPath)),
            size: file.size,
            uploadTime: new Date().toISOString(),
          };

          const imageId = await insertImageAsync(fileInfo);
          await linkImageToProjectAsync(projectIdNum, imageId);
          await finalizeUploadedRgb(imageId, projectIdNum || 0, fileInfo);
          fileInfo.id = imageId;

          job.files.push(fileInfo);
        } catch (e) {
          job.failed = (job.failed || 0) + 1;
          console.error('[upload][ingest] 单张图片入库失败:', e);
        } finally {
          job.processed += 1;
          const failed = job.failed || 0;
          job.message =
            failed > 0
              ? `正在入库处理... (${job.processed}/${job.total})（已失败 ${failed}）`
              : `正在入库处理... (${job.processed}/${job.total})`;
        }
      }

      job.status = 'completed';
      job.message =
        job.failed > 0 ? `入库处理完成（部分失败: ${job.failed}/${job.total}）` : '入库处理完成';
    } catch (e) {
      job.status = 'error';
      job.error = e?.message || String(e);
      job.message = '入库处理失败';
    }
  }

  // 文件上传接口（需要项目访问权限）
  router.post('/upload', upload.array('images', 2000), async (req, res) => {
    try {
      debugLog('node', 'node2DUpload', {
        stage: 'received',
        filesCount: Array.isArray(req.files) ? req.files.length : 0,
        projectId: req.body?.projectId ?? null,
      });
      const files = req.files;
      const { projectId } = req.body;
      const projectIdNum = projectId != null ? Number(projectId) : null;

      // 权限检查：如果有 projectId，需要检查访问权限
      if (projectIdNum) {
        const sessionId = req.sessionID;
        const hasAccess = await db.hasProjectAccess(sessionId, projectIdNum);
        if (!hasAccess && (!req.session || !req.session.isAdmin)) {
          return res.status(403).json({
            success: false,
            error: '没有访问该项目的权限，请先输入验证码',
          });
        }
      }
      const zipJobs = [];
      const imageJobs = [];
      const directImageFiles = [];

      const MAX_FILES_PER_UPLOAD = 2000;
      const totalIncoming = Array.isArray(files) ? files.length : 0;

      if (totalIncoming > MAX_FILES_PER_UPLOAD) {
        return res.status(400).json({
          success: false,
          message: `一次性上传的文件过多：当前 ${totalIncoming} 个，单次最多 ${MAX_FILES_PER_UPLOAD} 个`,
        });
      }

      if (!projectIdNum) {
        console.warn('⚠️ /api/upload 调用时未提供 projectId，本次上传的图片不会关联到任何项目');
      }

      if (totalIncoming === 0) {
        return res.json({ success: true, files: [], zipJobs: [], imageJobs: [], message: '未选择任何文件' });
      }

      // 严格校验：本次上传任何非图片内容都会导致整批失败，并清空本次上传
      try {
        await validateIncomingUploadOrThrow(files);
      } catch (vErr) {
        try {
          files.forEach((f) => safeUnlink(f.path));
        } catch (_) {}
        return res.status(400).json({
          success: false,
          error: vErr.code || 'UPLOAD_INVALID_CONTENT',
          message: vErr.message || '上传内容不合规',
          illegal: Array.isArray(vErr.illegal) ? vErr.illegal : [],
        });
      }

      files.forEach((file) => {
        const isZip = isZipName(file.originalname || '');
        const is7z = is7zName(file.originalname || '');

        if (isZip || is7z) {
          const jobId = makeJobId();
          uploadJobs.set(jobId, {
            id: jobId,
            status: 'queued',
            message: '等待解压...',
            zipOriginalName: file.originalname,
            total: 0,
            processed: 0,
            files: [],
          });

          zipJobs.push({
            jobId,
            originalName: file.originalname,
          });

          let finalArchivePath = file.path;
          if (projectIdNum) {
            const projectDir = getProjectUploadDir(projectIdNum);
            const archiveFilename = path.basename(file.path);
            finalArchivePath = path.join(projectDir, archiveFilename);
            try {
              fs.renameSync(file.path, finalArchivePath);
            } catch (err) {
              console.error('移动压缩包文件到项目文件夹失败:', err);
              finalArchivePath = file.path;
            }
          }

          setTimeout(() => {
            if (isZip) {
              runZipExtractJob({
                jobId,
                zipPath: finalArchivePath,
                zipOriginalName: file.originalname,
                projectId: projectIdNum,
              });
            } else {
              run7zExtractJob({
                jobId,
                archivePath: finalArchivePath,
                archiveOriginalName: file.originalname,
                projectId: projectIdNum,
              });
            }
          }, 50);
          return;
        }

        // 普通图片：放入“入库处理 job”，避免阻塞 /api/upload 请求响应
        directImageFiles.push(file);
      });

      if (directImageFiles.length > 0) {
        const jobId = makeJobId();
        uploadJobs.set(jobId, {
          id: jobId,
          status: 'queued',
          message: '等待入库...',
          total: directImageFiles.length,
          processed: 0,
          files: [],
          failed: 0,
        });

        imageJobs.push({ jobId });

        setTimeout(() => {
          void runDirectImagesProcessJob({ jobId, files: directImageFiles, projectId: projectIdNum });
        }, 50);
      }

      const message =
        directImageFiles.length > 0 && zipJobs.length > 0
          ? `上传完成：图片 ${directImageFiles.length} 个（入库中），压缩包 ${zipJobs.length} 个（解压中）`
          : directImageFiles.length > 0
            ? `上传完成：图片 ${directImageFiles.length} 个（入库中）`
            : `上传完成：压缩包 ${zipJobs.length} 个（解压中）`;

      res.json({
        success: true,
        files: [],
        zipJobs,
        imageJobs,
        message,
      });
    } catch (error) {
      console.error('❌ /api/upload 处理失败:', error);
      debugLog('node', 'node2DUpload', {
        stage: 'error',
        message: error?.message || String(error),
      });

      if (error && error.name === 'MulterError') {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: '上传失败：单个文件过大。当前单个 ZIP 或图片最大支持 3GB，请拆分后再上传。',
          });
        }
        return res.status(400).json({
          success: false,
          message: `上传失败：${error.message || 'Multer 处理文件时出错'}`,
        });
      }

      return res.status(500).json({
        success: false,
        message: '文件上传失败',
        error: error.message,
      });
    }
  });

  // 查询 ZIP 解压进度/结果
  router.get('/upload-jobs/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = uploadJobs.get(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'job 不存在或已过期',
      });
    }

    const total = job.total || 0;
    const processed = job.processed || 0;
    const progress = total > 0 ? Math.round((processed / total) * 100) : job.status === 'completed' ? 100 : 0;

    return res.json({
      success: true,
      job: {
        id: job.id,
        status: job.status,
        message: job.message,
        zipOriginalName: job.zipOriginalName,
        total,
        processed,
        progress,
        files: job.status === 'completed' ? job.files : [],
        error: job.status === 'error' ? job.error : null,
      },
    });
  });

  app.use('/api', router);
}

module.exports = { registerUploadRoutes };

