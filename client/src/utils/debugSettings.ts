export const DEBUG_SETTINGS_STORAGE_KEY = 'dax:debugSettings:v1';

export type DebugServiceId = 'frontend' | 'node' | 'sam2' | 'diffdope' | 'depthRepair';

export type DebugKind =
  | 'landingPage'
  | 'frontend2DUpload'
  | 'frontend2DDelete'
  | 'frontend9DMeshUpload'
  | 'frontend9DDepthUpload'
  | 'frontendProjectSessionGuard'
  | 'nodeSam2Request'
  | 'nodeSam2Result'
  | 'nodeDepthRepairRequest'
  | 'nodeDepthRepairResult'
  | 'nodeDiffdopeRequest'
  | 'nodeDiffdopeResult'
  | 'node2DUpload'
  | 'node2DDelete'
  | 'node9DMeshUpload'
  | 'node9DDepthUpload'
  | 'nodeDepthMatch'
  | 'nodeProjectLabelColors'
  | 'nodeProjectSessionGuard'
  | 'depthRepairAccessLog'
  | 'sam2AccessLog'
  | 'diffdopeAccessLog'
  | 'sam2TorchAttentionWarnings'
  | 'estimate6d_lossPbar'
  | 'diffdopeTorchExtensionsBuild'
  | 'sam2AutoLabelResult'
  | 'estimate6dResult'
  | 'depthRepairRepairDepthResult'
  | 'depthRepairXformersTritonWarnings'
  | 'startup'
  | 'cuda'
  | 'request'
  | 'params'
  | 'renderFitOverlay'
  ;

export type DebugSettingsPayload = {
  version: number;
  updatedAt?: string;
  services: Record<DebugServiceId, DebugKind[]>;
};

export const DEFAULT_DEBUG_SETTINGS: DebugSettingsPayload = {
  version: 1,
  services: {
    frontend: [],
    node: [],
    sam2: [],
    diffdope: [],
    depthRepair: [],
  },
};

export const DEBUG_KINDS_BY_SERVICE: Record<DebugServiceId, { kind: DebugKind; label: string; hint: string }[]> = {
  frontend: [
    { kind: 'landingPage', label: '项目管理页交互', hint: 'LandingPage 上模块切换/项目列表弹窗/创建项目等控制台输出' },
    { kind: 'frontend2DUpload', label: '2D 上传模块日志', hint: '2D 图片上传模块的前端交互与进度日志' },
    { kind: 'frontend2DDelete', label: '2D 删除模块日志', hint: '2D 图片删除流程的前端日志' },
    { kind: 'frontend9DMeshUpload', label: '9D Mesh 上传模块日志', hint: '9D Mesh 上传组件的前端日志' },
    { kind: 'frontend9DDepthUpload', label: '9D Depth 上传模块日志', hint: '9D Depth 上传组件的前端日志' },
    { kind: 'frontendProjectSessionGuard', label: '项目会话保护（前端）', hint: 'projectSession guard 的 claim/status/release 与断开跳转日志' },
  ],
  node: [
    { kind: 'nodeSam2Request', label: 'SAM2 标注请求（Node）', hint: 'Node 转发到 sam2-service 前的请求摘要日志' },
    { kind: 'nodeSam2Result', label: 'SAM2 标注结果（Node）', hint: 'Node 收到 sam2-service 响应后的结果摘要日志' },
    { kind: 'nodeDepthRepairRequest', label: 'Depth 修复请求（Node）', hint: 'Node 调用 depthrepair-service 前的请求摘要日志' },
    { kind: 'nodeDepthRepairResult', label: 'Depth 修复结果（Node）', hint: 'Node 收到 depthrepair-service 响应后的结果摘要日志' },
    { kind: 'nodeDiffdopeRequest', label: 'DiffDope 请求（Node）', hint: 'Node 调用 pose-service /diffdope/* 前的请求摘要日志' },
    { kind: 'nodeDiffdopeResult', label: 'DiffDope 结果（Node）', hint: 'Node 收到 pose-service /diffdope/* 响应后的结果摘要日志' },
    { kind: 'node2DUpload', label: '2D 上传日志（Node）', hint: '/api/upload 上传与解压流程日志' },
    { kind: 'node2DDelete', label: '2D 删除日志（Node）', hint: '/api/images/:id 删除流程日志' },
    { kind: 'node9DMeshUpload', label: '9D Mesh 上传日志（Node）', hint: '/api/meshes/upload 上传与入库流程日志' },
    { kind: 'node9DDepthUpload', label: '9D Depth 上传日志（Node）', hint: '/api/depth/upload 上传与入库流程日志' },
    { kind: 'nodeDepthMatch', label: 'Depth-Image-相机匹配日志（Node）', hint: 'depth 上传时 role/image/camera 绑定与匹配细节日志' },
    { kind: 'nodeProjectLabelColors', label: '项目标签颜色映射（Node）', hint: 'project_label_colors 的读取/替换/自动 upsert 与 color order 分配日志' },
    { kind: 'nodeProjectSessionGuard', label: '项目会话保护（Node）', hint: '项目单会话控制、被顶号、锁定/删除强制断开等日志' },
  ],
  sam2: [
    { kind: 'startup', label: '启动/加载', hint: 'SAM2 服务启动、模型加载等信息' },
    { kind: 'cuda', label: 'CUDA 详情', hint: 'CUDA 枚举与设备可用性相关输出' },
    { kind: 'request', label: '收到请求', hint: '收到自动标注请求时输出' },
    { kind: 'params', label: '推理参数', hint: 'SAM2 推理参数/输入缩放等细节输出' },
    { kind: 'sam2AccessLog', label: '访问日志（SAM2）', hint: '控制 sam2-service 的 Uvicorn access_log 输出（/api/auto-label、/health）' },
    {
      kind: 'sam2TorchAttentionWarnings',
      label: 'Torch Attention 警告',
      hint: '控制 PyTorch scaled_dot_product_attention/FlashAttention 等相关 UserWarning 输出（可能较多）',
    },
    {
      kind: 'sam2AutoLabelResult',
      label: 'SAM2 自动标注结果（成功/失败）',
      hint: '按单次 /api/auto-label 请求输出：成功时 masks/segments 数量，失败时错误信息（建议只在需要时开启）',
    },
  ],
  diffdope: [
    {
      kind: 'diffdopeAccessLog',
      label: '访问日志（DiffDope）',
      hint: '控制 pose-service 的 Uvicorn access_log 输出（/diffdope/*、/health）',
    },
    {
      kind: 'renderFitOverlay',
      label: '合成拟合图层',
      hint: '输出 render-fit-overlay 的逐 mesh 成功/失败（✅/❌）与最终汇总（renderedCount/failedCount/fitOverlayPath）',
    },
    { kind: 'estimate6d_lossPbar', label: 'estimate6d loss 进度条', hint: 'DiffDope 估计 6D 优化过程中的 tqdm loss 进度输出（loss: …）' },
    { kind: 'diffdopeTorchExtensionsBuild', label: 'Torch 扩展编译/加载日志', hint: '控制 torch_extensions / ninja / cpp_extension.load 的编译与加载输出（较多，且会在首次加载时出现）' },
    {
      kind: 'estimate6dResult',
      label: 'DiffDope estimate6d 结果（成功/失败概览）',
      hint: '按单次 /diffdope/estimate6d 请求输出成功/失败、quality-gate 通过情况等摘要信息',
    },
  ],
  depthRepair: [
    { kind: 'startup', label: '启动/加载', hint: '深度修复服务启动、模型加载等信息' },
    { kind: 'depthRepairAccessLog', label: '访问日志（DepthRepair）', hint: '控制 depthrepair-service 的 Uvicorn access_log 输出（/api/repair-depth）' },
    {
      kind: 'depthRepairXformersTritonWarnings',
      label: 'xformers/triton 警告与导入',
      hint: '控制 depthrepair-service 在导入 xformers/lingbot-depth 时的 triton 缺失与相关 DeprecationWarning 输出（可较多）',
    },
    {
      kind: 'depthRepairRepairDepthResult',
      label: 'DepthRepair /api/repair-depth 结果（成功/失败）',
      hint: '按单次 /api/repair-depth 请求输出成功/失败摘要（输出文件路径与关键统计）',
    },
  ],
};

function normalizeKindArray(raw: unknown): DebugKind[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(
    (Object.values(DEBUG_KINDS_BY_SERVICE) as { kind: DebugKind }[][]).flat().map((x) => x.kind),
  );
  return raw.filter((v) => typeof v === 'string' && allowed.has(v as DebugKind)) as DebugKind[];
}

export function normalizeDebugSettings(raw: unknown): DebugSettingsPayload {
  const base: DebugSettingsPayload = {
    ...DEFAULT_DEBUG_SETTINGS,
    services: { ...DEFAULT_DEBUG_SETTINGS.services },
  };
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;
  const services = o.services;
  if (!services || typeof services !== 'object') return base;
  const src = services as Record<string, unknown>;
  for (const id of Object.keys(base.services) as DebugServiceId[]) {
    base.services[id] = normalizeKindArray(src[id]);
  }
  if (typeof o.version === 'number') base.version = o.version;
  if (typeof o.updatedAt === 'string') base.updatedAt = o.updatedAt;
  return base;
}

export function readDebugSettingsFromStorage(): DebugSettingsPayload {
  try {
    const raw = localStorage.getItem(DEBUG_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DEBUG_SETTINGS, services: { ...DEFAULT_DEBUG_SETTINGS.services } };
    return normalizeDebugSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DEBUG_SETTINGS, services: { ...DEFAULT_DEBUG_SETTINGS.services } };
  }
}

export function writeDebugSettingsToStorage(settings: DebugSettingsPayload): void {
  try {
    localStorage.setItem(DEBUG_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeDebugSettings(settings)));
  } catch {
    /* ignore quota */
  }
}

export function shouldLogForServiceKind(service: DebugServiceId, kind: DebugKind, settings?: DebugSettingsPayload): boolean {
  const s = settings ?? readDebugSettingsFromStorage();
  return (s.services[service] || []).includes(kind);
}

/** 前端控制台封装：按服务与“调试种类”输出 */
export function debugLog(service: DebugServiceId, kind: DebugKind, ...args: unknown[]): void {
  if (!shouldLogForServiceKind(service, kind)) return;
  // Keep console output uniform: `[service][kind] ...payload`
  console.log(`[${service}][${kind}]`, ...args);
}
