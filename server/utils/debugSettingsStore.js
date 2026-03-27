const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'debug_settings.json');

const DEFAULTS = {
  version: 1,
  services: {
    frontend: [],
    node: [],
    sam2: [],
    diffdope: [],
    depthRepair: [],
  },
};

const ALLOWED_KINDS = new Set([
  'landingPage',
  'frontend2DUpload',
  'frontend2DDelete',
  'frontend9DMeshUpload',
  'frontend9DDepthUpload',
  'frontendProjectSessionGuard',
  'frontendSam2Queue',
  'frontendDiffdopeQueue',
  'nodeSam2Request',
  'nodeSam2Result',
  'nodeDepthRepairRequest',
  'nodeDepthRepairResult',
  'nodeDiffdopeRequest',
  'nodeDiffdopeResult',
  'node2DUpload',
  'node2DDelete',
  'node9DMeshUpload',
  'node9DDepthUpload',
  'nodeDepthMatch',
  'nodeProjectLabelColors',
  'nodeProjectSessionGuard',
  'nodeSam2Queue',
  'nodeDiffdopeQueue',
  'depthRepairAccessLog',
  'sam2AccessLog',
  'diffdopeAccessLog',
  'sam2TorchAttentionWarnings',
  'estimate6d_lossPbar',
  'diffdopeTorchExtensionsBuild',
  'sam2AutoLabelResult',
  'estimate6dResult',
  'depthRepairRepairDepthResult',
  'depthRepairXformersTritonWarnings',
  'startup',
  'cuda',
  'request',
  'params',
  'renderFitOverlay',
]);

function normalize(raw) {
  const services = { ...DEFAULTS.services };
  if (raw && typeof raw === 'object' && raw.services && typeof raw.services === 'object') {
    for (const k of Object.keys(services)) {
      const v = raw.services[k];
      if (Array.isArray(v)) {
        services[k] = v.filter((x) => typeof x === 'string' && ALLOWED_KINDS.has(x));
      }
    }
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    services,
  };
}

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readFileSync() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      cache = normalize(null);
      ensureDir();
      fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
      return cache;
    }
    const text = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    cache = normalize(parsed);
    return cache;
  } catch (e) {
    cache = normalize(null);
    return cache;
  }
}

function getDebugSettings() {
  if (cache) return cache;
  return readFileSync();
}

function setDebugSettings(body) {
  ensureDir();
  cache = normalize(body);
  fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

function shouldLogKind(service, kind) {
  const s = getDebugSettings();
  const enabled = s.services[service] || [];
  return enabled.includes(kind);
}

/** 重新从磁盘加载（便于外部改文件后生效） */
function reloadDebugSettings() {
  cache = null;
  return readFileSync();
}

function debugLog(service, kind, ...args) {
  if (!shouldLogKind(service, kind)) return;
  console.log(`[dax:${service}][${kind}]`, ...args);
}

module.exports = {
  getDebugSettings,
  setDebugSettings,
  shouldLogKind,
  reloadDebugSettings,
  debugLog,
  STORE_PATH,
};
