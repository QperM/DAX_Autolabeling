import React, { useCallback, useState } from 'react';
import JSZip from 'jszip';
import { pose9dApi } from '../../services/api';
import type { Image } from '../../types';
import { ProgressPopupModal, type ProgressPopupBar } from '../common/ProgressPopupModal';
import { useAppAlert } from '../common/AppAlert';

/** 与后端 meshes.bbox_json / GET /api/meshes 的 bbox 一致 */
export type PoseExportMeshBbox = {
  min?: { x: number; y: number; z: number };
  max?: { x: number; y: number; z: number };
  size?: { x: number; y: number; z: number };
  vertexCount?: number;
};

/** 与 Pose 页 mesh 列表一致的最小字段（含 bbox 时导出模型尺寸） */
export type PoseExportMesh = {
  id?: number;
  filename: string;
  originalName: string;
  skuLabel?: string | null;
  bbox?: PoseExportMeshBbox | null;
};

export type PoseExportProject = {
  id: number;
  name?: string;
};

const SCHEMA_VERSION = 3;

/** 与 PosePointCloudLayer 一致：OBJ 顶点/bbox 按米解释，导出尺寸用 cm */
const MESH_BBOX_METERS_TO_CM = 100;

const COORDINATE_NOTE_POSE44 =
  'pose44 为 OpenCV 相机坐标系下的 4×4 齐次变换矩阵 T_cam_obj（物体坐标 -> 相机坐标）。轴方向约定：+X 向右、+Y 向下、+Z 指向相机前方（离相机更远）。平移分量单位与系统内保存格式保持一致。';

const MODEL_SIZE_NOTE =
  'modelSize 为物体在 mesh 局部坐标系（与 OBJ 顶点坐标轴一致）下的轴对齐包围盒边长，单位 cm；由后端对 OBJ 顶点求得的 bbox 边长（本系统按「米」解释）乘以 100 得到。';

const MESH_VS_CAMERA_AXIS_NOTE =
  'mesh 局部坐标轴由建模/OBJ 导出决定，与 OpenCV 相机坐标轴（+X 右、+Y 下、+Z 前）无预设重合；物体在相机下的位姿与朝向以 pose44 为准。前端 3D 预览为 WebGL/Three 坐标系，与 pose44 之间通过固定坐标变换（如 Y/Z 取反）对应，仅影响展示，不改变导出的 pose44 与 modelSize 的含义。';

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
  // 优先使用“原始文件名（去后缀）”做匹配，便于用户快速配对。
  return `${safe}.json`;
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

    const sz = mesh?.bbox?.size;
    const modelSize =
      sz &&
      Number.isFinite(Number(sz.x)) &&
      Number.isFinite(Number(sz.y)) &&
      Number.isFinite(Number(sz.z))
        ? {
            unit: 'cm' as const,
            x: Number(sz.x) * MESH_BBOX_METERS_TO_CM,
            y: Number(sz.y) * MESH_BBOX_METERS_TO_CM,
            z: Number(sz.z) * MESH_BBOX_METERS_TO_CM,
          }
        : null;

    return {
      // 可识别主键（最小集合）
      imageId: image.id,
      meshId: Number.isFinite(mid) ? mid : null,
      maskId: row?.mask_id != null ? row.mask_id : null,
      label,
      modelSize,
      pose44,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dax_pose_per_image',
    exportedAt,
    coordinateNote: COORDINATE_NOTE_POSE44,
    modelSizeNote: MODEL_SIZE_NOTE,
    meshAxisNote: MESH_VS_CAMERA_AXIS_NOTE,
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

function isValidPose44(pose44: unknown): pose44 is number[][] {
  if (!Array.isArray(pose44) || pose44.length !== 4) return false;
  for (const row of pose44) {
    if (!Array.isArray(row) || row.length !== 4) return false;
    for (const v of row) {
      if (!Number.isFinite(Number(v))) return false;
    }
  }
  return true;
}

export async function buildPoseAnnotationsZipBlob(options: {
  project: PoseExportProject;
  images: Image[];
  meshes: PoseExportMesh[];
  onProgress?: (p: ExportPoseZipProgress) => void;
}): Promise<{ blob: Blob; exportedJsonCount: number }> {
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
  let exportedJsonCount = 0;

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

    // 需求：没有标注信息（没有最终 diffdope.pose44）则跳过该图，不生成空 json
    const hasAnyPose44 = poses.some((p: any) => isValidPose44(p?.diffdope?.pose44));
    if (!hasAnyPose44) {
      onProgress?.({
        phase: 'running',
        message: `跳过(无pose44标注)：${label}`,
        done: i + 1,
        total,
      });
      continue;
    }

    const doc = buildPoseExportDocumentForImage(project, image, poses, meshById);
    const fileName = poseImageJsonFileName(image);
    posesFolder?.file(fileName, JSON.stringify(doc, null, 2));
    exportedJsonCount += 1;
  }

  onProgress?.({ phase: 'running', message: '正在打包 ZIP…', done: total, total });

  const blob = await zip.generateAsync({ type: 'blob' });
  onProgress?.({ phase: 'done', message: '完成', done: total, total });
  return { blob, exportedJsonCount };
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
  className,
  disabled,
  onExportStart,
  onExportEnd,
}) => {
  const { alert } = useAppAlert();
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportPoseZipProgress | null>(null);

  const handleClick = useCallback(async () => {
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
      const { blob, exportedJsonCount } = await buildPoseAnnotationsZipBlob({
        project,
        images,
        meshes,
        onProgress: setProgress,
      });
      const day = new Date().toISOString().split('T')[0];
      const projSafe = safeZipBaseName(project.name || `project_${project.id}`, `project_${project.id}`);
      if (exportedJsonCount === 0) {
        alert('当前没有可导出的图片：无 pose44 标注。');
        return;
      }

      triggerDownload(blob, `pose_annotations_${projSafe}_project_${project.id}_${day}.zip`);
      alert(
        `已导出 ZIP：共 ${exportedJsonCount} 个 JSON（目录 poses/），含 pose44、modelSize（cm）及坐标说明字段。`,
      );
    } catch (e: any) {
      console.error('[PoseAnnotationsZipExport]', e);
      alert(e?.message || '导出失败');
      setProgress((p) => (p ? { ...p, phase: 'error', message: String(e?.message || 'error') } : null));
    } finally {
      setExporting(false);
      onExportEnd?.();
      setTimeout(() => setProgress(null), 1500);
    }
  }, [project, images, meshes, onExportStart, onExportEnd]);

  const title =
    '导出 6D Pose 标注：ZIP 内 poses/ 每图一 JSON（主键 + modelSize/cm + pose44 + 坐标说明）';

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <button
        type="button"
        className={className ?? 'ai-annotation-btn export-btn'}
        disabled={disabled || exporting || !project || images.length === 0}
        title={title}
        onClick={handleClick}
      >
        {exporting ? '导出中…' : '📥 导出标注数据'}
      </button>

      <ProgressPopupModal
        open={exporting && progress != null && progress.phase !== 'idle'}
        title="6D Pose 导出进度"
        bars={[
          {
            key: 'pose-export',
            title: '导出进度',
            percent,
            currentText: progress?.message || undefined,
          } satisfies ProgressPopupBar,
        ]}
        summary={
          total > 0 ? (
            <div>
              {done}/{total}
            </div>
          ) : undefined
        }
      />
    </>
  );
};

export default PoseAnnotationsZipExportButton;
