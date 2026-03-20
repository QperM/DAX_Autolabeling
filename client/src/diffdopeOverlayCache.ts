export type DiffDopeOverlayRecord = {
  meshId: number;
  imageId: number;
  label?: string | null;
  maskId?: string | null;
  maskIndex?: number;
  argmin?: number | null;
  pose44?: number[][] | null;
  timingSec?: number | null;
  debugImages?: {
    overlayRgbPngB64?: string;
    overlayDepthPngB64?: string;
    lossPlotPngB64?: string;
  };
  savedAt?: string;
};

const cache = new Map<string, DiffDopeOverlayRecord>();

export function makeDiffDopeOverlayKey(projectId: number | string, imageId: number | string, meshId: number | string) {
  return `diffdope:${projectId}:${imageId}:${meshId}`;
}

export function setDiffDopeOverlay(key: string, value: DiffDopeOverlayRecord) {
  cache.set(key, value);
}

export function getDiffDopeOverlay(key: string) {
  return cache.get(key) || null;
}

export function clearDiffDopeOverlayByPrefix(prefix: string) {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

