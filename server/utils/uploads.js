const path = require('path');
const fs = require('fs');

function ensureDir(p) {
  if (!p) return;
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// 获取项目文件夹路径：uploads/project_<id>/
function getProjectUploadDir(projectId) {
  if (!projectId) return path.join(__dirname, '..', 'uploads');
  const projectDir = path.join(__dirname, '..', 'uploads', `project_${projectId}`);
  ensureDir(projectDir);
  return projectDir;
}

// 根据 file_path 构建 URL（保留子目录）
function buildImageUrl(filePath, filename) {
  const uploadsDir = path.join(__dirname, '..', 'uploads');

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
    } catch (_) {}
  }

  return `/uploads/${encodeURIComponent(filename)}`;
}

// 根据目录路径构建 /uploads/<dir>/ 的 URL
function buildUploadsDirUrl(dirPath) {
  const uploadsDir = path.join(__dirname, '..', 'uploads');
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

