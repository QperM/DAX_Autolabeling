import React from 'react';
import MeshThumbnail from './MeshThumbnail';
import { useAppAlert } from '../common/AppAlert';

export type DiffDopeParams = {
  batchSize: number;
  depthSource: 'raw' | 'fix';
  useInitialPose: boolean;
  /** 若开启，仅对指定 meshId 对应的模型执行 diffdope（避免整张图跑全部 mesh） */
  onlySingleMesh: boolean;
  targetMeshId: number | null;
  maxAllowedFinalLoss: number;

  stage1Iters: number;
  stage1UseMask: boolean;
  stage1UseRgb: boolean;
  stage1WeightMask: number;
  stage1WeightRgb: number;
  stage1EarlyStopLoss: number;
  stage1BaseLr: number;
  stage1LrDecay: number;

  stage2Iters: number;
  stage2UseMask: boolean;
  stage2UseDepth: boolean;
  stage2UseRgb: boolean;
  stage2WeightMask: number;
  stage2WeightDepth: number;
  stage2WeightRgb: number;
  stage2EarlyStopLoss: number;
  stage2BaseLr: number;
  stage2LrDecay: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  diffDopeParams: DiffDopeParams;
  setDiffDopeParams: React.Dispatch<React.SetStateAction<DiffDopeParams>>;
  defaultDiffDopeParams: DiffDopeParams;
  currentProjectId: number | null;
  hasInitialPoseForSelectedImage: boolean | null;
  projectMeshes: Array<{
    id?: number;
    filename: string;
    originalName: string;
    url: string;
    assetDirUrl?: string;
    assets?: string[];
    skuLabel?: string | null;
  }>;
  isAdmin: boolean;
  onSaveAsDefault: (next: DiffDopeParams) => Promise<void> | void;
};

const PoseDiffDopeParamModal: React.FC<Props> = ({
  open,
  onClose,
  diffDopeParams,
  setDiffDopeParams,
  defaultDiffDopeParams,
  currentProjectId,
  hasInitialPoseForSelectedImage,
  projectMeshes,
  isAdmin,
  onSaveAsDefault,
}) => {
  const { alert } = useAppAlert();
  const useInitialPose = !!diffDopeParams.useInitialPose;
  const canUseInitialPose = hasInitialPoseForSelectedImage !== false;
  const meshOptions = React.useMemo(
    () =>
      projectMeshes
        .map((m) => ({
          id: typeof m.id === 'number' && Number.isFinite(m.id) ? m.id : null,
          skuLabel: (m.skuLabel || '').trim(),
          selectable: !!(m.skuLabel || '').trim(),
          displayText: (m.skuLabel || '').trim()
            ? (m.skuLabel || '').trim()
            : `${m.originalName || m.filename} 无可用 Label（请先在 2D 维护对照表）`,
          url: m.url,
          assetDirUrl: m.assetDirUrl,
          assets: m.assets,
        }))
        .filter((m) => m.id != null && m.id > 0 && m.url),
    [projectMeshes],
  );

  const [showSingleModelPicker, setShowSingleModelPicker] = React.useState(false);

  const selectableMeshOptions = meshOptions.filter((m) => m.selectable);
  const firstSelectableId = selectableMeshOptions[0]?.id ?? null;
  const selectedSingleMesh = meshOptions.find((m) => m.id === diffDopeParams.targetMeshId) ?? null;

  React.useEffect(() => {
    if (!open) setShowSingleModelPicker(false);
  }, [open]);

  const setStage1LossFlag = (key: 'stage1UseMask' | 'stage1UseRgb', value: boolean) => {
    setDiffDopeParams((p) => {
      const next = { ...p, [key]: value } as DiffDopeParams;
      if (!next.stage1UseMask && !next.stage1UseRgb) {
        alert('第一轮至少需要启用 Mask 与 RGB 中的一项');
        return p;
      }
      return next;
    });
  };

  const setStage2LossFlag = (key: 'stage2UseMask' | 'stage2UseDepth' | 'stage2UseRgb', value: boolean) => {
    setDiffDopeParams((p) => {
      const next = { ...p, [key]: value } as DiffDopeParams;
      const cnt = [next.stage2UseMask, next.stage2UseDepth, next.stage2UseRgb].filter(Boolean).length;
      if (cnt === 0) {
        alert('第二轮至少需要启用 Mask、Depth、RGB 中的一项');
        return p;
      }
      return next;
    });
  };

  if (!open) return null;

  return (
    <div className="ai-prompt-modal-backdrop" onClick={onClose}>
      <div
        className="ai-prompt-modal"
        style={{ width: 'min(720px, 94vw)', position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="ai-prompt-modal-title">调整拟合参数</h3>
        <div className="ai-prompt-modal-body">
          <div className="model-param-layout">
            <div className="model-param-group model-param-group-common">
              <div className="model-param-group-title">通用参数（两轮共用）</div>
              <div className="model-param-row">
                <div className="model-param-label">
                  <span>batchSize</span>
                  <span className="model-param-value">{diffDopeParams.batchSize}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={16}
                  step={1}
                  value={diffDopeParams.batchSize}
                  onChange={(e) => setDiffDopeParams((p) => ({ ...p, batchSize: Number(e.target.value) }))}
                />
                <div className="model-param-hint">并行候选数量。数值越大，搜索覆盖更广，但资源开销也会增加。</div>
              </div>
              <div className="model-param-row">
                <div className="model-param-label">
                  <span>深度来源</span>
                  <span className="model-param-value">{diffDopeParams.depthSource === 'fix' ? '修复深度' : '原始深度'}</span>
                </div>
                <div className="model-param-toggle-row">
                  <label style={{ whiteSpace: 'nowrap' }}>
                    <input
                      type="radio"
                      name="diffdope-depth-source"
                      checked={diffDopeParams.depthSource === 'raw'}
                      onChange={() => setDiffDopeParams((p) => ({ ...p, depthSource: 'raw' }))}
                    />
                    原始深度
                  </label>
                  <label style={{ whiteSpace: 'nowrap' }}>
                    <input
                      type="radio"
                      name="diffdope-depth-source"
                      checked={diffDopeParams.depthSource === 'fix'}
                      onChange={() => setDiffDopeParams((p) => ({ ...p, depthSource: 'fix' }))}
                    />
                    修复深度
                  </label>
                </div>
                <div className="model-param-hint">控制 AI 拟合时使用 `depth_raw` 还是 `depth_raw_fix`。选择修复深度但该图缺失时会跳过并提示。</div>
              </div>
              <div className="model-param-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%' }}>
                  <div className="model-param-label" style={{ marginBottom: 0 }}>
                    <span>使用初始位姿</span>
                  </div>
                  <div className="model-param-toggle-row" style={{ marginBottom: 0 }}>
                    <label style={{ whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        disabled={!canUseInitialPose}
                        checked={useInitialPose}
                        onChange={(e) => setDiffDopeParams((p) => ({ ...p, useInitialPose: e.target.checked }))}
                      />
                    </label>
                  </div>
                </div>
                <div
                  className="model-param-hint"
                  style={{
                    marginTop: 0,
                    marginBottom: 0,
                    lineHeight: 1.2,
                    whiteSpace: 'normal',
                    textAlign: 'left',
                  }}
                >
                  若该图中存在初始位姿，则用于初始化拟合；缺失初始姿态的模型仍会继续执行第一轮粗定位。
                </div>
              </div>

              <div className="model-param-row">
                <div
                  className="model-param-toggle-row"
                  style={{
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: '0.4rem',
                    marginBottom: 0,
                  }}
                >
                  {/* 第 1 行：仅标注单个模型 + 勾选框（同一行） */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                    <div className="model-param-label" style={{ marginBottom: 0 }}>
                      <span>仅标注单个模型</span>
                    </div>
                    <label style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        disabled={!selectableMeshOptions.length}
                        checked={diffDopeParams.onlySingleMesh}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          if (!checked) {
                            setDiffDopeParams((p) => ({ ...p, onlySingleMesh: false, targetMeshId: null }));
                            setShowSingleModelPicker(false);
                            return;
                          }
                          const currentOk = meshOptions.find((m) => m.id === diffDopeParams.targetMeshId)?.selectable;
                          const fallbackId = currentOk ? diffDopeParams.targetMeshId : firstSelectableId;
                          setDiffDopeParams((p) => ({
                            ...p,
                            onlySingleMesh: true,
                            targetMeshId: fallbackId,
                          }));
                          if (fallbackId != null) setShowSingleModelPicker(true);
                        }}
                      />
                    </label>
                  </div>

                  {/* 第 2 行：选择模型 + 缩略图 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {diffDopeParams.onlySingleMesh && (
                      <button
                        type="button"
                        className="ai-prompt-modal-btn secondary"
                        disabled={!selectableMeshOptions.length}
                        onClick={() => setShowSingleModelPicker(true)}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        选择模型
                      </button>
                    )}

                    {diffDopeParams.onlySingleMesh && selectedSingleMesh?.url && (
                      <div
                        style={{
                          width: 56,
                          height: 40,
                          borderRadius: 10,
                          overflow: 'hidden',
                          border: '1px solid rgba(226,232,240,0.9)',
                          background: '#020617',
                          flex: '0 0 auto',
                          flexShrink: 0,
                        }}
                        title={selectedSingleMesh.displayText || ''}
                      >
                        <MeshThumbnail
                          meshUrl={selectedSingleMesh.url}
                          assetDirUrl={selectedSingleMesh.assetDirUrl}
                          assets={selectedSingleMesh.assets}
                          label={selectedSingleMesh.displayText}
                          showBottomLabel={false}
                        />
                      </div>
                    )}
                  </div>
                </div>
                <div className="model-param-hint">开启后将只运行你选择的模型（mesh），其他模型会跳过。</div>
              </div>
            </div>

            <div className="model-param-columns">
              <div className="model-param-group">
                <div className="model-param-group-title">第一轮（粗定位）</div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>损失项（至少选一项）</span>
                    <span className="model-param-value">
                      {[diffDopeParams.stage1UseMask && 'Mask', diffDopeParams.stage1UseRgb && 'RGB'].filter(Boolean).join(' + ') || '-'}
                    </span>
                  </div>
                  <div className="model-param-toggle-row">
                    <label style={{ whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage1UseMask}
                        onChange={(e) => setStage1LossFlag('stage1UseMask', e.target.checked)}
                      />
                      Mask
                    </label>
                    <label style={{ whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage1UseRgb}
                        onChange={(e) => setStage1LossFlag('stage1UseRgb', e.target.checked)}
                      />
                      RGB
                    </label>
                  </div>
                  <div className="model-param-hint">第一轮仅支持 Mask 与 RGB（深度约束在第二轮）。仅对已勾选项可调权重。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage1UseMask ? ' is-disabled' : ''}`}>
                  <div className="model-param-label">
                    <span>mask 权重</span>
                    <span className="model-param-value">{diffDopeParams.stage1WeightMask.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={diffDopeParams.stage1WeightMask}
                    disabled={!diffDopeParams.stage1UseMask}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1WeightMask: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">轮廓约束强度。提高后会更强调边界一致性，过高可能引入波动。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage1UseRgb ? ' is-disabled' : ''}`}>
                  <div className="model-param-label">
                    <span>RGB 权重</span>
                    <span className="model-param-value">{diffDopeParams.stage1WeightRgb.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={diffDopeParams.stage1WeightRgb}
                    disabled={!diffDopeParams.stage1UseRgb}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1WeightRgb: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮 RGB 纹理一致性约束强度。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>第一轮学习率基值（base_lr）</span>
                    <span className="model-param-value">{diffDopeParams.stage1BaseLr.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.01}
                    max={60}
                    step={0.01}
                    value={diffDopeParams.stage1BaseLr}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1BaseLr: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮优化步长主参数。提高后更新更快，但也更容易震荡。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>第一轮学习率衰减（lr_decay）</span>
                    <span className="model-param-value">{diffDopeParams.stage1LrDecay.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={diffDopeParams.stage1LrDecay}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1LrDecay: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮学习率衰减强度。数值越小衰减越快，优化更稳但后期更新更慢。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>迭代次数</span>
                    <span className="model-param-value">{diffDopeParams.stage1Iters}</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={240}
                    step={1}
                    value={diffDopeParams.stage1Iters}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1Iters: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">当前阶段的优化步数。数值越大通常拟合更充分，但耗时会增加。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>早停阈值（loss）</span>
                    <span className="model-param-value">{diffDopeParams.stage1EarlyStopLoss > 0 ? diffDopeParams.stage1EarlyStopLoss.toFixed(2) : '关闭'}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.05}
                    value={diffDopeParams.stage1EarlyStopLoss}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1EarlyStopLoss: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">当前阶段 loss 低于该值时提前停止，用于节省计算时间。0 表示关闭。</div>
                </div>
              </div>

              <div className="model-param-group">
                <div className="model-param-group-title">第二轮（精修）</div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>损失项（至少选一项）</span>
                    <span className="model-param-value">
                      {[diffDopeParams.stage2UseMask && 'Mask', diffDopeParams.stage2UseDepth && 'Depth', diffDopeParams.stage2UseRgb && 'RGB']
                        .filter(Boolean)
                        .join(' + ') || '-'}
                    </span>
                  </div>
                  <div className="model-param-toggle-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage2UseMask}
                        onChange={(e) => setStage2LossFlag('stage2UseMask', e.target.checked)}
                      />
                      Mask
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage2UseDepth}
                        onChange={(e) => setStage2LossFlag('stage2UseDepth', e.target.checked)}
                      />
                      Depth
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage2UseRgb}
                        onChange={(e) => setStage2LossFlag('stage2UseRgb', e.target.checked)}
                      />
                      RGB
                    </label>
                  </div>
                  <div className="model-param-hint">仅对已勾选项调节下方对应权重；未勾选时滑条为灰色不可用。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage2UseMask ? ' is-disabled' : ''}`}>
                  <div className="model-param-label">
                    <span>mask 权重</span>
                    <span className="model-param-value">{diffDopeParams.stage2WeightMask.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={diffDopeParams.stage2WeightMask}
                    disabled={!diffDopeParams.stage2UseMask}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2WeightMask: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">轮廓约束强度。用于平衡边界对齐与优化稳定性。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage2UseDepth ? ' is-disabled' : ''}`}>
                  <div className="model-param-label">
                    <span>depth 权重</span>
                    <span className="model-param-value">{diffDopeParams.stage2WeightDepth.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={diffDopeParams.stage2WeightDepth}
                    disabled={!diffDopeParams.stage2UseDepth}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2WeightDepth: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">深度约束强度。用于平衡深度一致性与鲁棒性。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage2UseRgb ? ' is-disabled' : ''}`}>
                  <div className="model-param-label">
                    <span>RGB 权重（第二轮）</span>
                    <span className="model-param-value">{diffDopeParams.stage2WeightRgb.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={diffDopeParams.stage2WeightRgb}
                    disabled={!diffDopeParams.stage2UseRgb}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2WeightRgb: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">
                    第二轮 RGB 纹理一致性强度（请求字段 stage2WeightRgb，与后端 DIFFDOPE_DEFAULTS 对齐）。
                  </div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>第二轮学习率基值（base_lr）</span>
                    <span className="model-param-value">{diffDopeParams.stage2BaseLr.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.01}
                    max={60}
                    step={0.01}
                    value={diffDopeParams.stage2BaseLr}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2BaseLr: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">学习率主参数。提高后更新更快，但也更容易震荡。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>第二轮学习率衰减（lr_decay）</span>
                    <span className="model-param-value">{diffDopeParams.stage2LrDecay.toFixed(3)}</span>
                  </div>
                  <input
                    type="range"
                    min={0.01}
                    max={1}
                    step={0.01}
                    value={diffDopeParams.stage2LrDecay}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2LrDecay: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">学习率衰减强度。数值越小衰减越快，优化更稳但后期更新更慢。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>迭代次数</span>
                    <span className="model-param-value">{diffDopeParams.stage2Iters}</span>
                  </div>
                  <input
                    type="range"
                    min={40}
                    max={320}
                    step={1}
                    value={diffDopeParams.stage2Iters}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2Iters: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">当前阶段的优化步数。数值越大通常拟合更充分，但耗时会增加。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>早停阈值（loss）</span>
                    <span className="model-param-value">{diffDopeParams.stage2EarlyStopLoss > 0 ? diffDopeParams.stage2EarlyStopLoss.toFixed(2) : '关闭'}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.05}
                    value={diffDopeParams.stage2EarlyStopLoss}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage2EarlyStopLoss: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">当前阶段 loss 低于该值时提前停止，用于节省计算时间。0 表示关闭。</div>
                </div>

                <div className="model-param-row">
                  <div className="model-param-label">
                    <span>第二轮最大允许 loss</span>
                    <span className="model-param-value">{diffDopeParams.maxAllowedFinalLoss.toFixed(0)}</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={200}
                    step={1}
                    value={diffDopeParams.maxAllowedFinalLoss}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, maxAllowedFinalLoss: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">结果质量阈值。超过阈值将判定失败，并跳过结果落盘。</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {showSingleModelPicker && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(15, 23, 42, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 12,
              padding: '1rem',
              zIndex: 50,
            }}
            onClick={(e) => {
              e.stopPropagation();
              setShowSingleModelPicker(false);
            }}
          >
            <div
              className="ai-prompt-modal"
              style={{ width: 'min(560px, 94%)', margin: 0, position: 'static' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="ai-prompt-modal-title" style={{ marginBottom: '0.75rem' }}>
                选择要标注的模型
              </h3>
              <div className="ai-prompt-modal-body" style={{ maxHeight: '55vh', overflow: 'auto' }}>
                {meshOptions.length === 0 ? (
                  <div style={{ padding: '0.5rem 0', color: '#6b7280' }}>当前项目暂无可用 Mesh</div>
                ) : (
                  <div className="label-mapping-list mesh-label-mapping-list" style={{ maxHeight: '46vh' }}>
                    {meshOptions.map((m) => {
                      const isSelected = diffDopeParams.targetMeshId === m.id;
                      const disabled = !m.selectable;
                      return (
                        <div
                          key={m.id}
                          className="label-mapping-item mesh-label-mapping-item"
                          style={{
                            cursor: disabled ? 'not-allowed' : 'pointer',
                            opacity: disabled ? 0.7 : 1,
                            borderColor: isSelected ? '#667eea' : undefined,
                            boxShadow: isSelected ? '0 2px 10px rgba(102, 126, 234, 0.25)' : undefined,
                          }}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (disabled) return;
                            setDiffDopeParams((p) => ({
                              ...p,
                              onlySingleMesh: true,
                              targetMeshId: m.id,
                            }));
                            setShowSingleModelPicker(false);
                          }}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            if (disabled) return;
                            setDiffDopeParams((p) => ({
                              ...p,
                              onlySingleMesh: true,
                              targetMeshId: m.id,
                            }));
                            setShowSingleModelPicker(false);
                          }}
                        >
                          <div className="mesh-label-mapping-thumb-wrap">
                            <MeshThumbnail
                              meshUrl={m.url}
                              label={m.skuLabel || m.displayText}
                              assetDirUrl={m.assetDirUrl}
                              assets={m.assets}
                              showBottomLabel={false}
                            />
                          </div>
                          <div className="mesh-label-mapping-fields">
                            <div className="mesh-label-mapping-filename" title={m.displayText}>
                              {m.displayText}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="ai-prompt-modal-actions" style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="ai-prompt-modal-btn secondary"
                  onClick={() => setShowSingleModelPicker(false)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="ai-prompt-modal-actions">
          <button
            type="button"
            className="ai-prompt-modal-btn secondary"
            onClick={() => setDiffDopeParams({ ...defaultDiffDopeParams })}
          >
            恢复默认值
          </button>
          {isAdmin && (
            <button
              type="button"
              className="ai-prompt-modal-btn warning"
              onClick={() => onSaveAsDefault({ ...diffDopeParams })}
            >
              保存为默认值
            </button>
          )}
          <button
            type="button"
            className="ai-prompt-modal-btn primary"
            onClick={() => {
              if (currentProjectId != null) {
                localStorage.setItem(`diffDopeParams:${currentProjectId}`, JSON.stringify(diffDopeParams));
              }
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
};

export default PoseDiffDopeParamModal;

