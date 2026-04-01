const path = require('path');
const fs = require('fs');
const { getUploadsRootDir } = require('./dataPaths');

function ensureDir(p) {
  if (!p) return;
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// 获取项目文件夹路径：uploads/project_<id>/
function getProjectUploadDir(projectId) {
  if (!projectId) return getUploadsRootDir();
  const projectDir = path.join(getUploadsRootDir(), `project_${projectId}`);
  ensureDir(projectDir);
  return projectDir;
}

// 根据 file_path 构建 URL（保留子目录）
function buildImageUrl(filePath, filename) {
  const uploadsDir = getUploadsRootDir();

  if (filePath) {
    try {
      const rel = path.relative(uploadsDir, filePath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        const encoded = rel
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        return `/uploads/${encoded}`;
      }

      // Backward compatibility:
      // Some historical rows may still store absolute host paths
      // (e.g. Windows paths under old data roots). If so, preserve
      // the project-relative suffix like `project_2/images/xxx.png`.
      const normalized = String(filePath).replace(/\\/g, '/');
      const markerIdx = normalized.search(/\/project_\d+\//i);
      if (markerIdx >= 0) {
        const relFromProject = normalized.slice(markerIdx + 1); // remove leading '/'
        const encoded = relFromProject
          .split('/')
          .filter(Boolean)
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        if (encoded) return `/uploads/${encoded}`;
      }
    } catch (_) {}
  }

  return `/uploads/${encodeURIComponent(filename)}`;
}

// 根据目录路径构建 /uploads/<dir>/ 的 URL
function buildUploadsDirUrl(dirPath) {
  const uploadsDir = getUploadsRootDir();
  if (!dirPath) return '/uploads/';
  try {
    const rel = path.relative(uploadsDir, dirPath).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) {
      const encoded = rel
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      return `/uploads/${encoded}/`;
    }
  } catch (_) {}
  return '/uploads/';
}

module.exports = {
  getProjectUploadDir,
  buildImageUrl,
  buildUploadsDirUrl,
};

