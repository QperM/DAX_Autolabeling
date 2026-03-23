import React from 'react';

export type DiffDopeParams = {
  batchSize: number;
  useInitialPose: boolean;
  maxAllowedFinalLoss: number;
  diffDopeDebug: boolean;

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
};

const PoseDiffDopeParamModal: React.FC<Props> = ({
  open,
  onClose,
  diffDopeParams,
  setDiffDopeParams,
  defaultDiffDopeParams,
  currentProjectId,
  hasInitialPoseForSelectedImage,
}) => {
  const useInitialPose = !!diffDopeParams.useInitialPose;
  const canUseInitialPose = hasInitialPoseForSelectedImage !== false;

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
      <div className="ai-prompt-modal" style={{ width: 'min(720px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={diffDopeParams.diffDopeDebug !== false}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, diffDopeDebug: e.target.checked }))}
                  />
                  <span>详细调试日志</span>
                </label>
                <div className="model-param-hint">
                  开启后：浏览器控制台、Node 终端、pose-service 会打印两轮 loss 函数名、cfg 权重、各阶段结束时的位姿（t_gl / t_cv_cm、det R 等）。关闭可减少控制台输出。
                </div>
              </div>
            </div>

            <div className="model-param-columns">
              <div className="model-param-group">
                <div className="model-param-group-title">第一轮（粗定位）</div>

                <div className="model-param-row">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      disabled={!canUseInitialPose}
                      checked={useInitialPose}
                      onChange={(e) => setDiffDopeParams((p) => ({ ...p, useInitialPose: e.target.checked }))}
                    />
                    <span style={{ color: '#111827', fontWeight: 500 }}>使用初始位姿</span>
                  </label>
                </div>

                <div className={`model-param-row${useInitialPose ? ' is-disabled' : ''}`}>
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
                        disabled={useInitialPose}
                        onChange={(e) => setStage1LossFlag('stage1UseMask', e.target.checked)}
                      />
                      Mask
                    </label>
                    <label style={{ whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={!!diffDopeParams.stage1UseRgb}
                        disabled={useInitialPose}
                        onChange={(e) => setStage1LossFlag('stage1UseRgb', e.target.checked)}
                      />
                      RGB
                    </label>
                  </div>
                  <div className="model-param-hint">第一轮仅支持 Mask 与 RGB（深度约束在第二轮）。仅对已勾选项可调权重。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage1UseMask || useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={!diffDopeParams.stage1UseMask || useInitialPose}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1WeightMask: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">轮廓约束强度。提高后会更强调边界一致性，过高可能引入波动。</div>
                </div>

                <div className={`model-param-row${!diffDopeParams.stage1UseRgb || useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={!diffDopeParams.stage1UseRgb || useInitialPose}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1WeightRgb: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮 RGB 纹理一致性约束强度。</div>
                </div>

                <div className={`model-param-row${useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={useInitialPose}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1BaseLr: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮优化步长主参数。提高后更新更快，但也更容易震荡。</div>
                </div>

                <div className={`model-param-row${useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={useInitialPose}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1LrDecay: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">第一轮学习率衰减强度。数值越小衰减越快，优化更稳但后期更新更慢。</div>
                </div>

                <div className={`model-param-row${useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={useInitialPose}
                    onChange={(e) => setDiffDopeParams((p) => ({ ...p, stage1Iters: Number(e.target.value) }))}
                  />
                  <div className="model-param-hint">当前阶段的优化步数。数值越大通常拟合更充分，但耗时会增加。</div>
                </div>

                <div className={`model-param-row${useInitialPose ? ' is-disabled' : ''}`}>
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
                    disabled={useInitialPose}
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

        <div className="ai-prompt-modal-actions">
          <button type="button" className="ai-prompt-modal-btn secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="ai-prompt-modal-btn secondary"
            onClick={() => setDiffDopeParams({ ...defaultDiffDopeParams })}
          >
            恢复默认值
          </button>
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

