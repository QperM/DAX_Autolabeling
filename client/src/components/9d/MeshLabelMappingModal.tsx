import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { meshApi } from '../../services/api';
import MeshThumbnail from './MeshThumbnail';
import { useAppAlert } from '../common/AppAlert';

export type MeshLabelMappingRow = {
  id?: number;
  filename: string;
  originalName: string;
  url: string;
  assetDirUrl?: string;
  assets?: string[];
  skuLabel?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: number | null | undefined;
  meshes: MeshLabelMappingRow[];
  projectLabelOptions: Array<{ label: string; color: string }>;
  onMeshesUpdated: (meshes: MeshLabelMappingRow[]) => void;
};

/**
 * Pose 工作区：Mesh SKU Label 对照表（缩略图与底部网格一致，便于对齐 2D mask label）。
 */
export const MeshLabelMappingModal: React.FC<Props> = ({
  open,
  onClose,
  projectId,
  meshes,
  projectLabelOptions,
  onMeshesUpdated,
}) => {
  const { alert } = useAppAlert();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  /** 哪一行正在展开「带颜色的 Label 建议」面板（原生 datalist 无法按项着色） */
  const [openSuggestId, setOpenSuggestId] = useState<number | null>(null);
  /** 下拉层挂到 body + fixed，避免被 .label-mapping-list 的 overflow 裁剪 */
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const next: Record<number, string> = {};
    for (const m of meshes) {
      if (m.id != null) next[Number(m.id)] = String(m.skuLabel ?? '');
    }
    setDrafts(next);
  }, [open, meshes]);

  useEffect(() => {
    if (!open) setOpenSuggestId(null);
  }, [open]);

  useEffect(() => {
    if (openSuggestId == null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(`[data-mesh-suggest-row="${openSuggestId}"]`)) return;
      if (t?.closest?.('[data-mesh-label-dropdown-portal]')) return;
      setOpenSuggestId(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openSuggestId]);

  useEffect(() => {
    if (openSuggestId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenSuggestId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openSuggestId]);

  useLayoutEffect(() => {
    if (openSuggestId == null) {
      setDropdownRect(null);
      return;
    }
    const update = () => {
      const row = document.querySelector(`[data-mesh-suggest-row="${openSuggestId}"]`);
      const inner = row?.querySelector('.mesh-label-mapping-select-anchor') as HTMLElement | null;
      if (!inner) return;
      const r = inner.getBoundingClientRect();
      setDropdownRect({
        top: r.bottom + 4,
        left: r.left,
        width: Math.max(r.width, 220),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [openSuggestId, drafts]);

  const sortedLabelOptions = useMemo(() => {
    return projectLabelOptions
      .map((p) => ({ label: p.label.trim(), color: p.color.trim() }))
      .filter((p) => p.label && p.color)
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
  }, [projectLabelOptions]);

  const handleSave = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const next = meshes.map((m) => ({ ...m }));
      for (let i = 0; i < next.length; i++) {
        const m = next[i];
        if (m.id == null) continue;
        const id = Number(m.id);
        const newSku = (drafts[id] ?? '').trim();
        const oldSku = String(m.skuLabel ?? '').trim();
        if (newSku === oldSku) continue;
        await meshApi.updateMesh(id, { skuLabel: newSku || null });
        next[i] = { ...m, skuLabel: newSku || null };
      }
      onMeshesUpdated(next);
      onClose();
    } catch (e: unknown) {
      console.error('[MeshLabelMappingModal] save failed', e);
      const msg = e instanceof Error ? e.message : '保存失败';
      alert(msg);
    } finally {
      setSaving(false);
    }
  }, [projectId, meshes, drafts, onMeshesUpdated, onClose]);

  if (!open) return null;

  const list = meshes.filter((m) => m.id != null);

  return (
    <div className="ai-prompt-modal-backdrop" onClick={() => !saving && onClose()}>
      <div
        className="label-mapping-modal mesh-label-mapping-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 'min(720px, 94vw)' }}
      >
        <h3 className="ai-prompt-modal-title">Mesh Label 对照表</h3>
        <p className="ai-prompt-modal-desc">
          左侧为与底部 Mesh 缩略图相同的预览；右侧仅可从项目 Mask Label 列表中选择 SKU Label（与 2D 对照表一致，不允许手动输入）。保存后写入服务器。
        </p>
        {list.length === 0 ? (
          <div className="label-mapping-empty">当前项目暂无 Mesh，请先上传模型</div>
        ) : (
          <>
            <div className="label-mapping-list mesh-label-mapping-list">
              {list.map((m) => {
                const id = Number(m.id);
                const sku = drafts[id] ?? '';
                const colorHit = projectLabelOptions.find((p) => p.label.trim() === sku.trim());
                return (
                  <div key={id} className="label-mapping-item mesh-label-mapping-item">
                    <div className="mesh-label-mapping-thumb-wrap">
                      <MeshThumbnail
                        meshUrl={m.url}
                        label={m.originalName || m.filename}
                        assetDirUrl={m.assetDirUrl}
                        assets={m.assets}
                        showBottomLabel={false}
                      />
                    </div>
                    <div className="mesh-label-mapping-fields">
                      <div className="mesh-label-mapping-filename" title={m.originalName || m.filename}>
                        {m.originalName || m.filename}
                      </div>
                      <div
                        className="mesh-label-mapping-input-row mesh-label-mapping-combo-wrap"
                        data-mesh-suggest-row={id}
                      >
                        <div className="mesh-label-mapping-select-anchor">
                          <button
                            type="button"
                            className="mesh-label-mapping-select-trigger"
                            aria-expanded={openSuggestId === id}
                            aria-haspopup="listbox"
                            disabled={sortedLabelOptions.length === 0}
                            title={
                              sortedLabelOptions.length === 0
                                ? '请先在 2D 标注页维护「Mask Label 对照表」'
                                : '从列表选择 Label（带颜色），不可手动输入'
                            }
                            onClick={() => {
                              if (sortedLabelOptions.length === 0) return;
                              setOpenSuggestId((prev) => (prev === id ? null : id));
                            }}
                          >
                            <span
                              className="mesh-label-mapping-select-swatch"
                              style={{
                                backgroundColor: colorHit?.color || 'transparent',
                                border: colorHit?.color ? 'none' : '1px dashed #94a3b8',
                              }}
                              aria-hidden
                            />
                            <span
                              className={
                                sku.trim() && !colorHit
                                  ? 'mesh-label-mapping-select-text mesh-label-mapping-select-text--warn'
                                  : 'mesh-label-mapping-select-text'
                              }
                            >
                              {sortedLabelOptions.length === 0
                                ? '无可用 Label（请先在 2D 维护对照表）'
                                : sku.trim()
                                  ? colorHit
                                    ? sku
                                    : `${sku}（不在表中，请重选）`
                                  : '请选择…'}
                            </span>
                            <span className="mesh-label-mapping-select-caret" aria-hidden>
                              ▾
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {openSuggestId != null &&
              sortedLabelOptions.length > 0 &&
              dropdownRect &&
              typeof document !== 'undefined' &&
              createPortal(
                <div
                  data-mesh-label-dropdown-portal
                  className="mesh-label-mapping-dropdown-portal"
                  style={{
                    position: 'fixed',
                    top: dropdownRect.top,
                    left: dropdownRect.left,
                    width: dropdownRect.width,
                    zIndex: 10050,
                  }}
                >
                  <ul className="mesh-label-mapping-dropdown" role="listbox">
                    <li>
                      <button
                        type="button"
                        className="mesh-label-mapping-suggestion-btn mesh-label-mapping-suggestion-clear"
                        role="option"
                        onClick={() => {
                          const sid = openSuggestId;
                          if (sid == null) return;
                          setDrafts((prev) => ({ ...prev, [sid]: '' }));
                          setOpenSuggestId(null);
                        }}
                      >
                        <span className="mesh-label-mapping-suggestion-label">（清空 Label 绑定）</span>
                      </button>
                    </li>
                    {sortedLabelOptions.map((p) => (
                      <li key={p.label}>
                        <button
                          type="button"
                          className="mesh-label-mapping-suggestion-btn"
                          role="option"
                          onClick={() => {
                            const sid = openSuggestId;
                            if (sid == null) return;
                            setDrafts((prev) => ({ ...prev, [sid]: p.label }));
                            setOpenSuggestId(null);
                          }}
                        >
                          <span
                            className="mesh-label-mapping-suggestion-swatch"
                            style={{ backgroundColor: p.color }}
                            aria-hidden
                          />
                          <span className="mesh-label-mapping-suggestion-label">{p.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>,
                document.body,
              )}
          </>
        )}
        <div className="ai-prompt-modal-actions">
          <button
            type="button"
            className="ai-prompt-modal-btn secondary"
            onClick={() => !saving && onClose()}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="ai-prompt-modal-btn primary"
            onClick={() => void handleSave()}
            disabled={saving || list.length === 0}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MeshLabelMappingModal;
