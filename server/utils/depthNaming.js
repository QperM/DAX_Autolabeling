const path = require('path');

// 统一的 RGB/Depth/Intrinsics 命名归一化：
// 去掉前缀 depth_/depth_raw_/intrinsics_/rgb_ 和扩展名，只留下“语义部分”
function normalizeDepthKey(name) {
  if (!name) return '';
  const base = String(name).replace(/\\/g, '/').split('/').pop() || String(name);
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(/^(depth_raw_|depth_|intrinsics_|rgb_)/i, '');
}

function inferRoleFromFilename(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('left')) return 'left';
  if (lower.includes('right')) return 'right';
  if (lower.includes('head')) return 'head';
  // try strict prefix forms
  const base = path.basename(lower);
  const m = base.match(/^(intrinsics_|depth_raw_|depth_)(head|left|right)\b/);
  if (m?.[2]) return m[2];
  return null;
}

module.exports = {
  normalizeDepthKey,
  inferRoleFromFilename,
};

