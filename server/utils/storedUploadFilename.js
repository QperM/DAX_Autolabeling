const path = require('path');
const crypto = require('crypto');

/**
 * 统一上传落盘命名：proj_{projectId}_{uuid}.{ext}
 * - projectId 缺失或非正整数时使用 0（未关联项目的上传）
 * - ext 来自客户端原始文件名或当前落盘路径
 */
function normalizeStoredExt(originalName, fallbackPath) {
  const o = String(originalName || '');
  let ext = path.extname(o).toLowerCase();
  if (!ext && fallbackPath) ext = path.extname(String(fallbackPath)).toLowerCase();
  if (!ext) ext = '.bin';
  if (!ext.startsWith('.')) ext = `.${ext}`;
  return ext;
}

function buildProjUuidStoredBasename(projectId, originalName, currentAbsPath) {
  const pid = Number(projectId);
  const safePid = Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : 0;
  const ext = normalizeStoredExt(originalName, currentAbsPath);
  const uuid = crypto.randomUUID();
  return `proj_${safePid}_${uuid}${ext}`;
}

module.exports = { buildProjUuidStoredBasename, normalizeStoredExt };
