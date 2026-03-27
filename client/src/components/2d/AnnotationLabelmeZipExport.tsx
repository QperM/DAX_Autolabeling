import React, { useCallback, useState } from 'react';
import { useDispatch } from 'react-redux';
import JSZip from 'jszip';
import { annotationApi } from '../../services/api';
import type { AppDispatch } from '../../store';
import { setLoading } from '../../store/annotationSlice';
import type { Image, Mask, BoundingBox, Polygon } from '../../types';
import { useAppAlert } from '../common/AppAlert';

/** 与 AnnotationPage 中导出进度条一致 */
export type LabelmeExportProgressState = {
  active: boolean;
  mode: 'export' | null;
  total: number;
  completed: number;
  current: string;
};

// ----- Labelme JSON 形状（与 labelme 导出兼容）-----

export type LabelmeShape = {
  label: string;
  points: number[][];
  group_id?: number | null;
  description?: string;
  shape_type: string;
  flags?: Record<string, unknown>;
  mask?: unknown;
};

export type LabelmeJson = {
  version?: string;
  flags?: Record<string, unknown>;
  shapes: LabelmeShape[];
  imagePath?: string;
  imageData?: string | null;
  imageHeight?: number | null;
  imageWidth?: number | null;
  [k: string]: unknown;
};

export function normalizePathBaseName(p: string): string {
  const s = String(p || '').replace(/\\/g, '/');
  const parts = s.split('/');
  return (parts[parts.length - 1] || '').trim();
}

export function stripExt(name: string): string {
  const n = String(name || '').trim();
  return n.replace(/\.[^.]+$/, '');
}

export function flatPointsToPairs(pts: number[]): number[][] {
  const pairs: number[][] = [];
  const arr = Array.isArray(pts) ? pts : [];
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const x = Number(arr[i]);
    const y = Number(arr[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pairs.push([x, y]);
  }
  return pairs;
}

/** 由内部 masks / bbox / polygon 构建单张图的 labelme JSON */
export function buildLabelmeFromInternal(args: {
  image: Image;
  masks: Mask[];
  boundingBoxes: BoundingBox[];
  polygons: Polygon[];
}): LabelmeJson {
  const { image, masks, boundingBoxes, polygons } = args;
  const shapes: LabelmeShape[] = [];

  (masks || []).forEach((m) => {
    shapes.push({
      label: String(m.label || ''),
      points: flatPointsToPairs(m.points || []),
      group_id: null,
      description: '',
      shape_type: 'polygon',
      flags: {
        dax_type: 'mask',
        dax_id: m.id,
        dax_color: m.color,
        dax_opacity: m.opacity,
      },
      mask: null,
    });
  });

  (polygons || []).forEach((p) => {
    shapes.push({
      label: String(p.label || ''),
      points: flatPointsToPairs(p.points || []),
      group_id: null,
      description: '',
      shape_type: 'polygon',
      flags: {
        dax_type: 'polygon',
        dax_id: p.id,
        dax_color: p.color,
      },
      mask: null,
    });
  });

  (boundingBoxes || []).forEach((b) => {
    const x1 = Number(b.x);
    const y1 = Number(b.y);
    const x2 = Number(b.x + b.width);
    const y2 = Number(b.y + b.height);
    shapes.push({
      label: String(b.label || ''),
      points: [
        [x1, y1],
        [x2, y2],
      ],
      group_id: null,
      description: '',
      shape_type: 'rectangle',
      flags: {
        dax_type: 'bbox',
        dax_id: b.id,
        dax_color: b.color,
      },
      mask: null,
    });
  });

  return {
    version: '5.5.0',
    flags: {},
    shapes,
    imagePath: image.originalName || image.filename,
    imageData: null,
    imageHeight: typeof image.height === 'number' ? image.height : null,
    imageWidth: typeof image.width === 'number' ? image.width : null,
    dax: {
      source: 'DAXautolabeling',
      imageId: image.id,
      filename: image.filename,
      url: image.url,
    },
  };
}

export async function buildLabelmeZipBlob(options: {
  images: Image[];
  onProgress?: (completed: number, total: number, current: string) => void;
}): Promise<Blob> {
  const { images, onProgress } = options;
  const zip = new JSZip();
  const total = images.length;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const label = image.originalName || image.filename || `image_${image.id}`;
    onProgress?.(i, total, `导出: ${label}`);

    try {
      const resp = await annotationApi.getAnnotation(image.id);
      const anno = resp?.annotation;
      const masks0: Mask[] = anno?.masks || [];
      const bboxes0: BoundingBox[] = anno?.boundingBoxes || [];
      const polygons0: Polygon[] = anno?.polygons || [];

      const labelme = buildLabelmeFromInternal({
        image,
        masks: masks0,
        boundingBoxes: bboxes0,
        polygons: polygons0,
      });

      const baseName = stripExt(normalizePathBaseName(image.originalName || image.filename || `image_${image.id}`));
      const fileName = `${baseName || `image_${image.id}`}.json`;
      zip.file(fileName, JSON.stringify(labelme, null, 2));
    } catch (e) {
      console.warn(`[Labelme 导出] 获取图片 ${image.id} 标注失败，将导出空标注:`, e);
      const labelme = buildLabelmeFromInternal({
        image,
        masks: [],
        boundingBoxes: [],
        polygons: [],
      });
      const baseName = stripExt(normalizePathBaseName(image.originalName || image.filename || `image_${image.id}`));
      const fileName = `${baseName || `image_${image.id}`}.json`;
      zip.file(fileName, JSON.stringify(labelme, null, 2));
    }
    onProgress?.(i + 1, total, `导出: ${label}`);
  }

  return zip.generateAsync({ type: 'blob' });
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

export type AnnotationLabelmeZipExportButtonProps = {
  project: { id: number; name: string } | null;
  images: Image[];
  isAdmin: boolean;
  pageLoading?: boolean;
  setExportProgress: React.Dispatch<React.SetStateAction<LabelmeExportProgressState>>;
};

/**
 * 2D 标注页：仅支持导出 Labelme 兼容 ZIP（每图一个 JSON）。
 */
export const AnnotationLabelmeZipExportButton: React.FC<AnnotationLabelmeZipExportButtonProps> = ({
  project,
  images,
  pageLoading,
  setExportProgress,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const { alert } = useAppAlert();
  const [exporting, setExporting] = useState(false);

  const handleExport = useCallback(async () => {
    if (!project) {
      alert('请先选择项目');
      return;
    }
    if (images.length === 0) {
      alert('当前没有可导出的图片');
      return;
    }

    setExporting(true);
    setExportProgress({
      active: true,
      mode: 'export',
      total: images.length,
      completed: 0,
      current: `开始导出（共 ${images.length} 张）`,
    });
    dispatch(setLoading(true));

    try {
      const blob = await buildLabelmeZipBlob({
        images,
        onProgress: (completed, total, current) => {
          setExportProgress((prev) => ({
            ...prev,
            total,
            completed,
            current,
          }));
        },
      });
      const day = new Date().toISOString().split('T')[0];
      const safeName = String(project.name || `project_${project.id}`).replace(/[^\w\u4e00-\u9fff-]+/g, '_');
      triggerDownload(blob, `labelme_${safeName}_${day}.zip`);
      alert(`Labelme ZIP 导出成功！\n\n共导出 ${images.length} 个 JSON（每图一个）`);
    } catch (error: unknown) {
      console.error('导出标注数据失败:', error);
      const msg = error instanceof Error ? error.message : '未知错误';
      alert(`导出失败: ${msg}`);
    } finally {
      dispatch(setLoading(false));
      setExporting(false);
      setTimeout(() => {
        setExportProgress((prev) => ({ ...prev, active: false, mode: null, current: '' }));
      }, 1200);
    }
  }, [dispatch, images, project, setExportProgress]);

  return (
    <button
      type="button"
      className="ai-annotation-btn export-btn"
      onClick={handleExport}
      disabled={!project || images.length === 0 || !!pageLoading || exporting}
      title={'导出为 Labelme 兼容 ZIP（每图一个 JSON）'}
    >
      {exporting ? '导出中…' : '📥 导出标注数据'}
    </button>
  );
};

export default AnnotationLabelmeZipExportButton;
