import React, { useState } from 'react';
import type { Image, Mask, BoundingBox } from '../../types';
import { annotationApi, projectApi } from '../../services/api';
import { ProgressPopupModal, type ProgressPopupBar } from './ProgressPopupModal';
import { useAppAlert } from './AppAlert';

type Props = {
  currentProjectId: number | null;
  images: Image[];
  selectedPreviewImage: Image | null;
  previewDisplayMode: 'image' | 'mask';
  onRefreshAnnotationSummary: () => Promise<void> | void;
  onReloadPreviewMasks: (imageId: number) => Promise<void> | void;
  onClearThumbnailMasks: () => void;
};

const ColorLabelMappingManager: React.FC<Props> = ({
  currentProjectId,
  images,
  selectedPreviewImage,
  previewDisplayMode,
  onRefreshAnnotationSummary,
  onReloadPreviewMasks,
  onClearThumbnailMasks,
}) => {
  const { alert, confirm } = useAppAlert();
  const [open, setOpen] = useState(false);
  const [mapping, setMapping] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{
    active: boolean;
    total: number;
    completed: number;
    current: string;
    color: string;
    label?: string;
  }>({
    active: false,
    total: 0,
    completed: 0,
    current: '',
    color: '',
    label: '',
  });

  const loadColorLabelMapping = async () => {
    if (!currentProjectId) {
      setMapping(new Map());
      return;
    }

    setLoading(true);
    try {
      const colorMap = new Map<string, string>();
      const mappings = await projectApi.getLabelColors(Number(currentProjectId));
      mappings.forEach((m) => {
        const color = String(m?.color || '').trim();
        const label = String(m?.label || '').trim();
        if (!color || !label) return;
        if (!colorMap.has(color)) colorMap.set(color, label);
      });
      setMapping(colorMap);
    } catch (e) {
      await alert('加载颜色-label 映射失败: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveColorLabelMapping = async () => {
    if (!currentProjectId || images.length === 0) {
      await alert('当前没有可更新的图片');
      return;
    }

    const confirmMsg = `确定要将颜色-label 映射应用到所有 ${images.length} 张图片的标注吗？\n\n这将按颜色批量修改所有标注的 label。`;
    if (!(await confirm(confirmMsg, { title: '确认批量应用' }))) return;

    setLoading(true);
    let successCount = 0;
    let failCount = 0;

    try {
      for (const image of images) {
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) continue;

          let hasChanges = false;
          const updatedMasks = (anno.masks || []).map((mask: Mask) => {
            if (mask.color && mapping.has(mask.color)) {
              const newLabel = mapping.get(mask.color)!;
              if (mask.label !== newLabel) {
                hasChanges = true;
                return { ...mask, label: newLabel };
              }
            }
            return mask;
          });

          const updatedBBoxes = (anno.boundingBoxes || []).map((bbox: BoundingBox) => {
            if (bbox.color && mapping.has(bbox.color)) {
              const newLabel = mapping.get(bbox.color)!;
              if (bbox.label !== newLabel) {
                hasChanges = true;
                return { ...bbox, label: newLabel };
              }
            }
            return bbox;
          });

          if (hasChanges) {
            await annotationApi.saveAnnotation(image.id, {
              masks: updatedMasks,
              boundingBoxes: updatedBBoxes,
              polygons: anno.polygons || [],
            });
          }
          successCount++;
        } catch (e) {
          console.error(`[ColorLabelMappingManager] 更新图片 ${image.id} 失败:`, e);
          failCount++;
        }
      }

      try {
        const payload: Array<{ label: string; color: string; usageOrder?: number }> = [];
        let usageOrder = 0;
        for (const [color, label] of mapping.entries()) {
          const trimmed = label.trim();
          if (!trimmed) continue;
          payload.push({ label: trimmed, color, usageOrder });
          usageOrder += 1;
        }
        await projectApi.saveLabelColors(Number(currentProjectId), payload);
      } catch (e) {
        console.warn('[ColorLabelMappingManager] 写入后端颜色-label 映射失败:', e);
      }

      await alert(`批量更新完成！\n\n成功: ${successCount} 张\n失败: ${failCount} 张`);
      setOpen(false);
      await onRefreshAnnotationSummary();
      if (selectedPreviewImage && previewDisplayMode === 'mask') {
        await onReloadPreviewMasks(selectedPreviewImage.id);
      }
    } catch (e) {
      console.error('[ColorLabelMappingManager] 批量保存失败:', e);
      await alert('批量保存失败: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const deleteAnnotationsByColor = async (targetColor: string) => {
    if (!currentProjectId || images.length === 0) {
      await alert('当前没有可更新的图片');
      return;
    }

    const label = (mapping.get(targetColor) || '').trim();
    const confirmMsg =
      `确定要删除该颜色对应的所有标注吗？\n\n` +
      `颜色: ${targetColor}${label ? `\nLabel: ${label}` : ''}\n\n` +
      `这会遍历所有 ${images.length} 张图片，并删除所有 color = ${targetColor} 的 Mask / 框。\n` +
      `该操作不可撤销。`;
    if (!(await confirm(confirmMsg, { title: '确认删除' }))) return;

    const totalImages = images.length;
    setLoading(true);
    setDeleteProgress({
      active: true,
      total: totalImages,
      completed: 0,
      current: '开始删除...',
      color: targetColor,
      label,
    });

    let affectedImages = 0;
    let deletedMasks = 0;
    let deletedBBoxes = 0;
    let failCount = 0;
    let processed = 0;

    try {
      for (const image of images) {
        setDeleteProgress((prev) => ({
          ...prev,
          current: `处理中: ${image.originalName || image.filename || `image_${image.id}`}`,
          completed: processed,
        }));
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) continue;

          const beforeMasks = (anno.masks || []) as Mask[];
          const beforeBBoxes = (anno.boundingBoxes || []) as BoundingBox[];
          const afterMasks = beforeMasks.filter((m) => m.color !== targetColor);
          const afterBBoxes = beforeBBoxes.filter((b) => b.color !== targetColor);
          const masksRemoved = beforeMasks.length - afterMasks.length;
          const bboxesRemoved = beforeBBoxes.length - afterBBoxes.length;
          if (masksRemoved === 0 && bboxesRemoved === 0) continue;

          deletedMasks += masksRemoved;
          deletedBBoxes += bboxesRemoved;
          affectedImages += 1;

          await annotationApi.saveAnnotation(image.id, {
            masks: afterMasks,
            boundingBoxes: afterBBoxes,
            polygons: anno.polygons || [],
          });
        } catch (e) {
          console.error(`[ColorLabelMappingManager] 删除颜色更新图片 ${image.id} 失败:`, e);
          failCount++;
        } finally {
          processed += 1;
          setDeleteProgress((prev) => ({ ...prev, completed: processed }));
        }
      }

      const nextMap = new Map(mapping);
      nextMap.delete(targetColor);
      setMapping(nextMap);

      try {
        const payload: Array<{ label: string; color: string; usageOrder?: number }> = [];
        let usageOrder = 0;
        for (const [color, l] of nextMap.entries()) {
          const trimmed = l.trim();
          if (!trimmed) continue;
          payload.push({ label: trimmed, color, usageOrder });
          usageOrder += 1;
        }
        await projectApi.saveLabelColors(Number(currentProjectId), payload);
      } catch (e) {
        console.warn('[ColorLabelMappingManager] 写入后端颜色-label 映射失败:', e);
      }

      onClearThumbnailMasks();
      await onRefreshAnnotationSummary();
      if (selectedPreviewImage && previewDisplayMode === 'mask') {
        await onReloadPreviewMasks(selectedPreviewImage.id);
      }

      setDeleteProgress((prev) => ({
        ...prev,
        total: totalImages,
        completed: totalImages,
        current: '删除完成！',
      }));
      await new Promise((r) => setTimeout(r, 80));

      await alert(
        `删除完成！\n\n` +
          `影响图片: ${affectedImages} 张\n` +
          `删除 Masks: ${deletedMasks}\n` +
          `删除 框: ${deletedBBoxes}\n` +
          `失败: ${failCount} 张`
      );
    } catch (e) {
      console.error('[ColorLabelMappingManager] 批量删除失败:', e);
      await alert('批量删除失败: ' + (e as Error).message);
    } finally {
      setLoading(false);
      setTimeout(() => {
        setDeleteProgress((prev) => ({ ...prev, active: false, current: '' }));
      }, 1200);
    }
  };

  return (
    <>
      <button
        type="button"
        className="label-mapping-btn"
        onClick={async () => {
          if (!currentProjectId) {
            await alert('请先选择项目');
            return;
          }
          setOpen(true);
          await loadColorLabelMapping();
        }}
      >
        🏷️ Mask Label 对照表
      </button>

      {open && (
        <div className="ai-prompt-modal-backdrop" onClick={() => !loading && setOpen(false)}>
          <div className="label-mapping-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="ai-prompt-modal-title">Mask Label 对照表</h3>
            <p className="ai-prompt-modal-desc">左侧显示颜色，右侧可编辑对应的 label。保存后将应用到整个项目的所有图片标注。</p>
            {loading && mapping.size === 0 ? (
              <div className="label-mapping-loading">加载中...</div>
            ) : mapping.size === 0 ? (
              <div className="label-mapping-empty">当前项目暂无标注数据</div>
            ) : (
              <div className="label-mapping-list">
                {Array.from(mapping.entries()).map(([color, label]) => (
                  <div key={color} className="label-mapping-item">
                    <span className="label-mapping-color-dot" style={{ backgroundColor: color }} />
                    <input
                      className="label-mapping-input"
                      type="text"
                      value={label}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const trimmed = raw.trim();
                        const newMap = new Map(mapping);
                        newMap.set(color, raw);
                        if (trimmed.length > 0) {
                          for (const [c, l] of Array.from(newMap.entries())) {
                            if (c === color) continue;
                            if (l.trim() === trimmed) newMap.delete(c);
                          }
                        }
                        setMapping(newMap);
                      }}
                      placeholder="输入 label 名称"
                    />
                    <button
                      type="button"
                      className="label-mapping-delete-btn"
                      title="删除该颜色对应的所有标注（跨项目所有图片）"
                      disabled={loading}
                      onClick={() => !loading && void deleteAnnotationsByColor(color)}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-prompt-modal-actions">
              <button type="button" className="ai-prompt-modal-btn secondary" onClick={() => setOpen(false)} disabled={loading}>
                取消
              </button>
              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => void saveColorLabelMapping()}
                disabled={loading || mapping.size === 0}
              >
                {loading ? '保存中...' : '保存并全局应用'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ProgressPopupModal
        open={deleteProgress.active && deleteProgress.total > 0}
        title="删除进度"
        bars={[
          {
            key: 'delete-by-color',
            title: '删除进度',
            percent: (deleteProgress.completed / Math.max(1, deleteProgress.total)) * 100,
            currentText: [
              deleteProgress.label ? `Label: ${deleteProgress.label} | 颜色: ${deleteProgress.color}` : `颜色: ${deleteProgress.color}`,
              deleteProgress.current ? String(deleteProgress.current) : '',
            ]
              .filter(Boolean)
              .join('\n'),
          } satisfies ProgressPopupBar,
        ]}
      />
    </>
  );
};

export default ColorLabelMappingManager;

