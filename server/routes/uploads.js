const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

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

  function safeBaseName(name) {
    const base = path.basename(name || 'image');
    return base.replace(/[^\w.\-()\s]/g, '_');
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

  async function runZipExtractJob({ jobId, zipPath, zipOriginalName, projectId }) {
    const job = uploadJobs.get(jobId);
    if (!job) return;

    job.status = 'extracting';
    job.message = '正在解压...';

    const uploadDir = getProjectUploadDir(projectId);
    try {
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries().filter((e) => !e.isDirectory);

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
        const orig = safeBaseName(entry.entryName);
        const ext = path.extname(orig);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const filename = `images-${uniqueSuffix}${ext}`;
        const outPath = path.join(uploadDir, filename);

        const data = entry.getData();
        fs.writeFileSync(outPath, data);

        // 构建相对路径的URL（如果是在项目文件夹中，需要包含项目文件夹路径）
        const relativePath = projectId ? `project_${projectId}/${filename}` : filename;

        const fileInfo = {
          filename,
          originalName: orig,
          path: outPath,
          url: `/uploads/${encodeURIComponent(relativePath)}`,
          size: data.length,
          uploadTime: new Date().toISOString(),
        };

        const imageId = await insertImageAsync(fileInfo);
        fileInfo.id = imageId;
        await linkImageToProjectAsync(projectId, imageId);

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

  // 文件上传接口（需要项目访问权限）
  router.post('/upload', upload.array('images', 2000), async (req, res) => {
    try {
      const files = req.files;
      const uploadedFiles = [];
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

      let completed = 0;
      if (totalIncoming === 0) {
        return res.json({ success: true, files: [], zipJobs: [], message: '未选择任何文件' });
      }

      files.forEach((file) => {
        const isZip = path.extname(file.originalname || '').toLowerCase() === '.zip';

        if (isZip) {
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

          let finalZipPath = file.path;
          if (projectIdNum) {
            const projectDir = getProjectUploadDir(projectIdNum);
            const zipFilename = path.basename(file.path);
            finalZipPath = path.join(projectDir, zipFilename);
            try {
              fs.renameSync(file.path, finalZipPath);
            } catch (err) {
              console.error('移动ZIP文件到项目文件夹失败:', err);
              finalZipPath = file.path;
            }
          }

          setTimeout(() => {
            runZipExtractJob({
              jobId,
              zipPath: finalZipPath,
              zipOriginalName: file.originalname,
              projectId: projectIdNum,
            });
          }, 50);

          completed++;
          if (completed === totalIncoming) {
            res.json({
              success: true,
              files: uploadedFiles,
              zipJobs,
              message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个（解压中）`,
            });
          }
          return;
        }

        // 普通图片：移动到项目目录
        let finalPath = file.path;
        let finalUrl = `/uploads/${encodeURIComponent(file.filename)}`;

        if (projectIdNum) {
          const projectDir = getProjectUploadDir(projectIdNum);
          const finalFilename = path.basename(file.path);
          finalPath = path.join(projectDir, finalFilename);
          try {
            fs.renameSync(file.path, finalPath);
            finalUrl = `/uploads/project_${projectIdNum}/${encodeURIComponent(finalFilename)}`;
          } catch (err) {
            console.error('移动文件到项目文件夹失败:', err);
            finalPath = file.path;
          }
        }

        const fileInfo = {
          filename: path.basename(finalPath),
          originalName: file.originalname,
          path: finalPath,
          url: finalUrl,
          size: file.size,
          uploadTime: new Date().toISOString(),
        };

        db.insertImage(fileInfo, (err, imageId) => {
          if (err) {
            console.error('保存图片信息失败:', err);
            completed++;
            if (completed === totalIncoming) {
              res.json({
                success: true,
                files: uploadedFiles,
                zipJobs,
                message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个（部分图片可能保存失败）`,
              });
            }
            return;
          }

          fileInfo.id = imageId;

          const finishOne = () => {
            uploadedFiles.push(fileInfo);
            completed++;
            if (completed === totalIncoming) {
              res.json({
                success: true,
                files: uploadedFiles,
                zipJobs,
                message: `上传完成：图片 ${uploadedFiles.length} 个，压缩包 ${zipJobs.length} 个`,
              });
            }
          };

          if (projectIdNum) {
            db.linkImageToProject(projectIdNum, imageId, (linkErr) => {
              if (linkErr) console.error('关联图片到项目失败:', linkErr);
              finishOne();
            });
          } else {
            finishOne();
          }
        });
      });
    } catch (error) {
      console.error('❌ /api/upload 处理失败:', error);

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

