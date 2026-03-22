import React, { useCallback, useState } from 'react';
import JSZip from 'jszip';
import { pose9dApi } from '../../services/api';
import type { Image } from '../../types';

/** 与 Pose 页 mesh 列表一致的最小字段 */
export type PoseExportMesh = {
  id?: number;
  filename: string;
  originalName: string;
  skuLabel?: string | null;
};

export type PoseExportProject = {
  id: number;
  name?: string;
};

const SCHEMA_VERSION = 1;

export function safeZipBaseName(raw: string, fallback: string): string {
  const noPath = String(raw || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]/g, '_');
  const cleaned = noPath.replace(/[^\w.\u4e00-\u9fff-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const trimmed = cleaned.slice(0, 120);
  return trimmed || fallback;
}

export function stripExtension(name: string): string {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return s;
  return s.slice(0, i);
}

export function poseImageJsonFileName(image: Pick<Image, 'id' | 'filename' | 'originalName'>): string {
  const base = stripExtension(image.originalName || image.filename || `image_${image.id}`);
  const safe = safeZipBaseName(base, `image_${image.id}`);
  return `image_${image.id}_${safe}.json`;
}

export function buildPoseExportDocumentForImage(
  project: PoseExportProject,
  image: Pick<Image, 'id' | 'filename' | 'originalName' | 'width' | 'height'>,
  poseRows: any[],
  meshById: Map<number, PoseExportMesh>,
): Record<string, unknown> {
  const exportedAt = new Date().toISOString();
  const instances = (poseRows || []).map((row: any) => {
    const mid = row?.mesh_id != null ? Number(row.mesh_id) : NaN;
    const mesh = Number.isFinite(mid) ? meshById.get(mid) : undefined;
    const sku = (mesh?.skuLabel != null && String(mesh.skuLabel).trim()) || '';
    const label =
      sku ||
      (mesh?.originalName && String(mesh.originalName).trim()) ||
      (mesh?.filename && String(mesh.filename).trim()) ||
      (Number.isFinite(mid) ? `mesh_${mid}` : 'unknown_mesh');

    const diffdope = row?.diffdope && typeof row.diffdope === 'object' ? row.diffdope : null;
    const pose44 = diffdope && Array.isArray((diffdope as any).pose44) ? (diffdope as any).pose44 : null;

    return {
      label,
      meshId: Number.isFinite(mid) ? mid : null,
      mesh: mesh
        ? {
            filename: mesh.filename,
            originalName: mesh.originalName,
            skuLabel: mesh.skuLabel ?? null,
          }
        : null,
      pose6d: {
        pose44,
        method: diffdope && (diffdope as any).method != null ? (diffdope as any).method : null,
        argmin: diffdope && (diffdope as any).argmin != null ? (diffdope as any).argmin : null,
        timingSec: diffdope && (diffdope as any).timingSec != null ? (diffdope as any).timingSec : null,
      },
      pose9d: row?.pose != null ? row.pose : null,
      fitOverlayPath: row?.fitOverlayPath ?? row?.fit_overlay_path ?? null,
      recordUpdatedAt: row?.updated_at ?? null,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dax_pose_per_image',
    exportedAt,
    coordinateNote:
      'pose44 为 4×4 齐次变换矩阵；与系统内 Diff-DOPE / 人工标注保存格式一致（通常为 OpenCV 相机坐标系）。',
    project: {
      id: project.id,
      name: project.name ?? '',
    },
    image: {
      id: image.id,
      filename: image.filename,
      originalName: image.originalName,
      width: image.width ?? null,
      height: image.height ?? null,
    },
    instances,
  };
}

export type ExportPoseZipProgress = {
  phase: 'idle' | 'running' | 'done' | 'error';
  message: string;
  done: number;
  total: number;
};

export async function buildPoseAnnotationsZipBlob(options: {
  project: PoseExportProject;
  images: Image[];
  meshes: PoseExportMesh[];
  onProgress?: (p: ExportPoseZipProgress) => void;
}): Promise<Blob> {
  const { project, images, meshes, onProgress } = options;
  const meshById = new Map<number, PoseExportMesh>();
  for (const m of meshes) {
    if (m.id != null && Number.isFinite(Number(m.id))) {
      meshById.set(Number(m.id), m);
    }
  }

  const zip = new JSZip();
  const posesFolder = zip.folder('poses');

  const total = images.length;
  onProgress?.({ phase: 'running', message: '开始导出…', done: 0, total });

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const label = image.originalName || image.filename || `image_${image.id}`;
    onProgress?.({
      phase: 'running',
      message: `读取 Pose：${label}`,
      done: i,
      total,
    });

    let poses: any[] = [];
    try {
      const resp = await pose9dApi.listPose9D(image.id);
      poses = Array.isArray(resp?.poses) ? resp.poses : [];
    } catch (e) {
      console.warn('[PoseAnnotationsZipExport] listPose9D failed:', image.id, e);
      poses = [];
    }

    const doc = buildPoseExportDocumentForImage(project, image, poses, meshById);
    const fileName = poseImageJsonFileName(image);
    posesFolder?.file(fileName, JSON.stringify(doc, null, 2));
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dax_pose_zip_manifest',
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name ?? '' },
    imageCount: images.length,
    contents: {
      posesFolder: 'poses/',
      perImageJson: '每图一个 JSON，instances 为该图下多个物体（按 mesh 区分），含 label 与 pose44。',
    },
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  onProgress?.({ phase: 'running', message: '正在打包 ZIP…', done: total, total });

  const blob = await zip.generateAsync({ type: 'blob' });
  onProgress?.({ phase: 'done', message: '完成', done: total, total });
  return blob;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type PoseAnnotationsZipExportButtonProps = {
  project: PoseExportProject | null;
  images: Image[];
  meshes: PoseExportMesh[];
  isAdmin: boolean;
  className?: string;
  disabled?: boolean;
  onExportStart?: () => void;
  onExportEnd?: () => void;
};

export const PoseAnnotationsZipExportButton: React.FC<PoseAnnotationsZipExportButtonProps> = ({
  project,
  images,
  meshes,
  isAdmin,
  className,
  disabled,
  onExportStart,
  onExportEnd,
}) => {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportPoseZipProgress | null>(null);

  const handleClick = useCallback(async () => {
    if (!isAdmin) {
      alert('当前账号无权限导出标注数据，请联系管理员操作');
      return;
    }
    if (!project?.id) {
      alert('请先选择项目');
      return;
    }
    if (!images.length) {
      alert('当前没有可导出的图片');
      return;
    }

    setExporting(true);
    onExportStart?.();
    setProgress({ phase: 'running', message: '准备导出…', done: 0, total: images.length });

    try {
      const blob = await buildPoseAnnotationsZipBlob({
        project,
        images,
        meshes,
        onProgress: setProgress,
      });
      const day = new Date().toISOString().split('T')[0];
      const projSafe = safeZipBaseName(project.name || `project_${project.id}`, `project_${project.id}`);
      triggerDownload(blob, `pose_annotations_${projSafe}_${day}.zip`);
      alert(`已导出 ZIP：共 ${images.length} 个 JSON（目录 poses/），含 6D pose44 与模型/图片原始名称。`);
    } catch (e: any) {
      console.error('[PoseAnnotationsZipExport]', e);
      alert(e?.message || '导出失败');
      setProgress((p) => (p ? { ...p, phase: 'error', message: String(e?.message || 'error') } : null));
    } finally {
      setExporting(false);
      onExportEnd?.();
      setTimeout(() => setProgress(null), 1500);
    }
  }, [isAdmin, project, images, meshes, onExportStart, onExportEnd]);

  const title =
    '导出 6D Pose 标注：ZIP 内 manifest.json + poses/ 每图一 JSON（多物体在 instances 中，含 label、mesh 与图片原始文件名）';

  return (
    <button
      type="button"
      className={className ?? 'ai-annotation-btn export-btn'}
      disabled={disabled || exporting || !project || images.length === 0}
      title={title}
      onClick={handleClick}
    >
      {exporting
        ? `导出中…${progress && progress.total > 0 ? ` (${Math.min(progress.done + 1, progress.total)}/${progress.total})` : ''}`
        : '📥 导出标注数据'}
    </button>
  );
};

export default PoseAnnotationsZipExportButton;
