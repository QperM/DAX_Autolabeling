import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Image, Mask, BoundingBox } from '../../types';
import { annotationApi, projectApi, imageApi } from '../../services/api';
import { ProgressPopupModal, type ProgressPopupBar } from './ProgressPopupModal';
import { useAppAlert } from './AppAlert';
import { ANNOTATION_COLOR_PALETTE, SAM2_OBJECT_RESERVED_COLOR } from './annotationColors';

type Props = {
  currentProjectId: number | null;
  selectedPreviewImage: Image | null;
  previewDisplayMode: 'image' | 'mask';
  onRefreshAnnotationSummary: () => Promise<void> | void;
  onReloadPreviewMasks: (imageId: number) => Promise<void> | void;
  onClearThumbnailMasks?: () => void;
};

type MappingRow = {
  color: string;
  label: string;
  labelZh: string;
  usageOrder: number;
  updatedAt: string | null;
};

/** 最近更新/新建的条目在前，便于 AI 重标后立刻在第一行看到 object / 蓝色等 */
function sortMappingRowsForDisplay(rows: MappingRow[]): MappingRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (tb !== ta) return tb - ta;
    if (b.usageOrder !== a.usageOrder) return b.usageOrder - a.usageOrder;
    return a.color.localeCompare(b.color);
  });
}

const ColorLabelMappingManager: React.FC<Props> = ({
  currentProjectId,
  selectedPreviewImage,
  previewDisplayMode,
  onRefreshAnnotationSummary,
  onReloadPreviewMasks,
  onClearThumbnailMasks,
}) => {
  const { alert, confirm } = useAppAlert();
  const [open, setOpen] = useState(false);
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const displayRows = useMemo(() => sortMappingRowsForDisplay(mappingRows), [mappingRows]);
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

  const buildLabelColorsPayload = (rows: MappingRow[]) => {
    const payload: Array<{ label: string; labelZh?: string; color: string; usageOrder?: number }> = [];
    let usageOrder = 0;
    for (const row of sortMappingRowsForDisplay(rows)) {
      const trimmed = row.label.trim();
      if (!trimmed) continue;
      payload.push({ label: trimmed, labelZh: row.labelZh.trim(), color: row.color, usageOrder });
      usageOrder += 1;
    }
    return payload;
  };

  const persistLabelColorsToDb = async (rows: MappingRow[]) => {
    if (!currentProjectId) return;
    const payload = buildLabelColorsPayload(rows);
    const saved = await projectApi.saveLabelColors(Number(currentProjectId), payload);
    const byColor = new Map<string, MappingRow>();
    saved.forEach((m: any) => {
      const color = String(m?.color || '').trim();
      const label = String(m?.label || '').trim();
      if (!color || !label) return;
      if (!byColor.has(color)) {
        byColor.set(color, {
          color,
          label,
          labelZh: String(m?.labelZh || '').trim(),
          usageOrder: Number(m?.usageOrder ?? 0),
          updatedAt: m?.updatedAt != null ? String(m.updatedAt) : null,
        });
      }
    });
    setMappingRows(Array.from(byColor.values()));
  };

  const pickNextPaletteColor = (excludedColors: Set<string>) => {
    let maxUsedIndex = -1;
    for (let i = 0; i < ANNOTATION_COLOR_PALETTE.length; i += 1) {
      const c = ANNOTATION_COLOR_PALETTE[i];
      if (excludedColors.has(c) && i > maxUsedIndex) maxUsedIndex = i;
    }
    const nextIndex = maxUsedIndex + 1;
    if (nextIndex >= ANNOTATION_COLOR_PALETTE.length) return ANNOTATION_COLOR_PALETTE[ANNOTATION_COLOR_PALETTE.length - 1];
    return ANNOTATION_COLOR_PALETTE[nextIndex];
  };

  const handleAddMappingRow = async () => {
    if (!currentProjectId) {
      await alert('请先选择项目');
      return;
    }
    // 颜色顺延：按 palette 中已使用的最大下标 + 1 取下一个颜色。
    const usedColors = new Set<string>(mappingRows.map((r) => r.color));
    usedColors.add(SAM2_OBJECT_RESERVED_COLOR);
    const nextColor = pickNextPaletteColor(usedColors);

    const existingLabels = new Set(mappingRows.map((r) => String(r.label || '').trim()).filter(Boolean));
    let idx = mappingRows.length + 1;
    let nextLabel = `new_label_${idx}`;
    while (existingLabels.has(nextLabel)) {
      idx += 1;
      nextLabel = `new_label_${idx}`;
    }

    const now = new Date().toISOString();
    const nextRows: MappingRow[] = [
      ...mappingRows,
      { color: nextColor, label: nextLabel, labelZh: '', usageOrder: mappingRows.length, updatedAt: now },
    ];

    setLoading(true);
    try {
      setMappingRows(nextRows);
      // 仅写入映射表（不触发批量重写所有图片标注）
      await persistLabelColorsToDb(nextRows);
    } catch (e: any) {
      console.error('[ColorLabelMappingManager] 新增映射失败:', e);
      await alert('新增失败: ' + (e?.response?.data?.message || e?.message || String(e)));
      // 回滚 UI
      await loadColorLabelMapping();
    } finally {
      setLoading(false);
    }
  };

  const loadColorLabelMapping = async () => {
    if (!currentProjectId) {
      setMappingRows([]);
      return;
    }

    setLoading(true);
    try {
      const mappings = await projectApi.getLabelColors(Number(currentProjectId));
      const byColor = new Map<string, MappingRow>();
      mappings.forEach((m) => {
        const color = String(m?.color || '').trim();
        const label = String(m?.label || '').trim();
        if (!color || !label) return;
        if (!byColor.has(color)) {
          byColor.set(color, {
            color,
            label,
            labelZh: String((m as any)?.labelZh || '').trim(),
            usageOrder: Number(m?.usageOrder ?? 0),
            updatedAt: m?.updatedAt != null ? String(m.updatedAt) : null,
          });
        }
      });
      setMappingRows(Array.from(byColor.values()));
    } catch (e) {
      await alert('加载颜色-label 映射失败: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveColorLabelMapping = async () => {
    if (!currentProjectId) {
      await alert('请先选择项目');
      return;
    }

    const allImages = await imageApi.getImages(currentProjectId);
    if (allImages.length === 0) {
      await alert('当前没有可更新的图片');
      return;
    }

    const confirmMsg = `确定要将颜色-label 映射应用到所有 ${allImages.length} 张图片的标注吗？\n\n这将按颜色批量修改所有标注的 label。`;
    if (!(await confirm(confirmMsg, { title: '确认批量应用' }))) return;

    const labelByColor = new Map(mappingRows.map((r) => [r.color, r.label]));

    setLoading(true);
    let successCount = 0;
    let failCount = 0;

    try {
      for (const image of allImages) {
        try {
          const resp = await annotationApi.getAnnotation(image.id);
          const anno = resp?.annotation;
          if (!anno) continue;

          let hasChanges = false;
          const updatedMasks = (anno.masks || []).map((mask: Mask) => {
            if (mask.color && labelByColor.has(mask.color)) {
              const newLabel = labelByColor.get(mask.color)!;
              if (mask.label !== newLabel) {
                hasChanges = true;
                return { ...mask, label: newLabel };
              }
            }
            return mask;
          });

          const updatedBBoxes = (anno.boundingBoxes || []).map((bbox: BoundingBox) => {
            if (bbox.color && labelByColor.has(bbox.color)) {
              const newLabel = labelByColor.get(bbox.color)!;
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
        await persistLabelColorsToDb(mappingRows);
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
    if (!currentProjectId) {
      await alert('请先选择项目');
      return;
    }

    const label = (mappingRows.find((r) => r.color === targetColor)?.label || '').trim();

    const allImages = await imageApi.getImages(currentProjectId);
    if (allImages.length === 0) {
      await alert('当前没有可更新的图片');
      return;
    }

    const confirmMsg =
      `确定要删除该颜色对应的所有标注吗？\n\n` +
      `颜色: ${targetColor}${label ? `\nLabel: ${label}` : ''}\n\n` +
      `这会遍历所有 ${allImages.length} 张图片，并删除所有 color = ${targetColor} 的 Mask / 框。\n` +
      `该操作不可撤销。`;
    if (!(await confirm(confirmMsg, { title: '确认删除' }))) return;

    const totalImages = allImages.length;
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
      for (const image of allImages) {
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

      const nextRows = mappingRows.filter((r) => r.color !== targetColor);
      setMappingRows(nextRows);

      try {
        await persistLabelColorsToDb(nextRows);
      } catch (e) {
        console.warn('[ColorLabelMappingManager] 写入后端颜色-label 映射失败:', e);
      }

      onClearThumbnailMasks?.();
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

  /** 与 ModelConfigModal 一致：挂到 body + 透明遮罩 + 视口居中，避免被 welcome 区布局裁剪或灰底覆盖整页 */
  const mappingModalNode =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="ai-prompt-modal-backdrop"
            style={{
              background: 'transparent',
              zIndex: 1500,
              position: 'fixed',
              inset: 0,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
            onClick={() => !loading && setOpen(false)}
          >
            <div className="label-mapping-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="ai-prompt-modal-title">Mask Label 对照表</h3>
              <p className="ai-prompt-modal-desc">左侧显示颜色，右侧可编辑对应的 label。保存后将应用到整个项目的所有图片标注。</p>
              {loading && mappingRows.length === 0 ? (
                <div className="label-mapping-loading">加载中...</div>
              ) : mappingRows.length === 0 ? (
                <div className="label-mapping-empty">当前项目暂无颜色-Label 映射（`project_label_colors` 为空）</div>
              ) : (
                <div className="label-mapping-list">
                  {displayRows.map(({ color, label, labelZh }) => (
                    <div key={color} className="label-mapping-item">
                      <span className="label-mapping-color-dot" style={{ backgroundColor: color }} />
                      <input
                        className="label-mapping-input"
                        type="text"
                        value={label}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const trimmed = raw.trim();
                          const now = new Date().toISOString();
                          setMappingRows((prev) => {
                            let next = prev.map((r) =>
                              r.color === color ? { ...r, label: raw, updatedAt: now } : r,
                            );
                            if (trimmed.length > 0) {
                              next = next.filter((r) => r.color === color || r.label.trim() !== trimmed);
                            }
                            return next;
                          });
                        }}
                        placeholder="主 label（拼音）"
                      />
                      <input
                        className="label-mapping-input"
                        type="text"
                        value={labelZh}
                        onChange={(e) => {
                          const raw = e.target.value;
                          const now = new Date().toISOString();
                          setMappingRows((prev) =>
                            prev.map((r) => (r.color === color ? { ...r, labelZh: raw, updatedAt: now } : r)),
                          );
                        }}
                        placeholder="中文昵称（仅前端显示）"
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
                  className="ai-prompt-modal-btn secondary"
                  onClick={() => void handleAddMappingRow()}
                  disabled={loading}
                  title="新增一条颜色-label 映射（颜色自动顺延，并立即写入数据库）"
                >
                  新增
                </button>
                <button
                  type="button"
                  className="ai-prompt-modal-btn primary"
                  onClick={() => void saveColorLabelMapping()}
                  disabled={loading || mappingRows.length === 0}
                >
                  {loading ? '保存中...' : '保存并全局应用'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

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

      {mappingModalNode}

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

