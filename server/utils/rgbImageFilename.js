const path = require('path');
const crypto = require('crypto');

/**
 * 入库后最终 RGB 文件名：固定前缀 rgb_img + 主键 id + 清洗后的原名主干（可区分、可检索）。
 * 与 depthNaming.normalizeDepthKey 配合：去掉 rgb_ / rgb_img{n}_ 后仍可与深度图按「语义主干」对齐。
 */
function buildRgbStoredBasename(imageId, originalDisplayName, currentAbsPath) {
  const disp = String(originalDisplayName || 'image').replace(/\\/g, '/');
  const base = path.basename(disp);
  const extRaw = path.extname(base);
  let ext = extRaw.toLowerCase();
  if (!ext && currentAbsPath) {
    ext = path.extname(String(currentAbsPath)).toLowerCase();
  }
  if (!ext) ext = '.bin';
  const stemSource = extRaw ? base.slice(0, base.length - extRaw.length) : base;
  let stem = String(stemSource || '')
    .replace(/[^\w.\-() \u4e00-\u9fff]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  stem = stem.slice(0, 56);
  if (!stem) {
    stem = `x${crypto.randomBytes(4).toString('hex')}`;
  }
  return `rgb_img${Number(imageId)}_${stem}${ext}`;
}

module.exports = { buildRgbStoredBasename };
