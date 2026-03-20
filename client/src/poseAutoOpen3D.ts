type PoseAutoOpen3DFlag = {
  projectId: number;
  imageId: number;
  meshId?: number | null;
  source?: 'initial' | 'diffdope' | 'manual';
  createdAt: string;
};

const KEY = 'pose:autoOpen3D';

function getSessionStorageSafe(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function setPoseAutoOpen3D(flag: PoseAutoOpen3DFlag) {
  const ss = getSessionStorageSafe();
  if (!ss) return;
  try {
    ss.setItem(KEY, JSON.stringify(flag));
  } catch {
    // ignore
  }
}

export function popPoseAutoOpen3D(): PoseAutoOpen3DFlag | null {
  const ss = getSessionStorageSafe();
  if (!ss) return null;
  const raw = ss.getItem(KEY);
  ss.removeItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PoseAutoOpen3DFlag;
  } catch {
    return null;
  }
}

