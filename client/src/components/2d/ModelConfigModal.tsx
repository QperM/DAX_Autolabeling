import React, { useState } from 'react';

type Sam2ModelParams = {
  maxPolygonPoints: number;
  sam2PointsPerSide: number;
  sam2PredIouThresh: number;
  sam2StabilityScoreThresh: number;
  sam2BoxNmsThresh: number;
  sam2MinMaskRegionArea: number;
  sam2MergeGapPx: number;
};

type Props = {
  hasProject: boolean;
  isAdmin: boolean;
  modelParams: Sam2ModelParams;
  globalDefaultModelParams: Sam2ModelParams;
  setModelParams: React.Dispatch<React.SetStateAction<Sam2ModelParams>>;
  onSaveAsGlobalDefault: () => void | Promise<void>;
  onSaveAndClose: () => void | Promise<void>;
  onMissingProject: () => void | Promise<void>;
};

const ModelConfigModal: React.FC<Props> = ({
  hasProject,
  isAdmin,
  modelParams,
  globalDefaultModelParams,
  setModelParams,
  onSaveAsGlobalDefault,
  onSaveAndClose,
  onMissingProject,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="ai-model-config-btn"
        onClick={() => {
          if (!hasProject) {
            void onMissingProject();
            return;
          }
          setOpen(true);
        }}
      >
        调整模型参数
      </button>

      {open && (
        <div className="ai-prompt-modal-backdrop" onClick={() => setOpen(false)}>
          <div className="ai-prompt-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="ai-prompt-modal-title">调整模型参数</h3>
            <p className="ai-prompt-modal-desc">当前仅保留 SAM2 自动分割模型，以下参数会按项目单独保存。</p>

            <div className="model-param-group">
              <div className="model-param-row">
                <div className="model-param-label">当前模型</div>
                <div className="ai-prompt-input" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  SAM2 AMG
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 points_per_side
                  <span className="model-param-value">{modelParams.sam2PointsPerSide}</span>
                </div>
                <input
                  type="range"
                  min={8}
                  max={64}
                  step={4}
                  value={modelParams.sam2PointsPerSide}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2PointsPerSide: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">越大分割越细，但更慢。</div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 pred_iou_thresh
                  <span className="model-param-value">{modelParams.sam2PredIouThresh.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={0.98}
                  step={0.02}
                  value={modelParams.sam2PredIouThresh}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2PredIouThresh: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">越高越严格，保留的 mask 更少。</div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 stability_score_thresh
                  <span className="model-param-value">{modelParams.sam2StabilityScoreThresh.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={0.98}
                  step={0.02}
                  value={modelParams.sam2StabilityScoreThresh}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2StabilityScoreThresh: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">越高越偏向稳定的大块区域。</div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 box_nms_thresh
                  <span className="model-param-value">{modelParams.sam2BoxNmsThresh.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={0.95}
                  step={0.05}
                  value={modelParams.sam2BoxNmsThresh}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2BoxNmsThresh: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  控制候选框去重强度（NMS）。它主要抑制高度重叠的重复候选，值越大，会出现的重叠越多。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 min_mask_region_area
                  <span className="model-param-value">{modelParams.sam2MinMaskRegionArea}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20000}
                  step={500}
                  value={modelParams.sam2MinMaskRegionArea}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2MinMaskRegionArea: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">过滤掉特别小的噪声区域（像素面积）。0 表示不过滤。</div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  SAM2 merge_gap_px（后处理合并）
                  <span className="model-param-value">{modelParams.sam2MergeGapPx}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={modelParams.sam2MergeGapPx}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      sam2MergeGapPx: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">
                  专门用于“相邻区域合并”。值越大，越会把距离很近的 mask（如瓶身与瓶盖）并成一个；设为 0 则关闭该后处理。
                </div>
              </div>

              <div className="model-param-row">
                <div className="model-param-label">
                  轮廓精细度（最大点数）
                  <span className="model-param-value">{modelParams.maxPolygonPoints}</span>
                </div>
                <input
                  type="range"
                  min={40}
                  max={400}
                  step={10}
                  value={modelParams.maxPolygonPoints}
                  onChange={(e) =>
                    setModelParams((prev) => ({
                      ...prev,
                      maxPolygonPoints: Number(e.target.value),
                    }))
                  }
                />
                <div className="model-param-hint">控制从 mask 轮廓抽样的最大点数。越大边缘越贴合，但生成/渲染更重。</div>
              </div>
            </div>

            <div className="ai-prompt-modal-actions">
              <button
                type="button"
                className="ai-prompt-modal-btn secondary"
                onClick={() => {
                  setModelParams(globalDefaultModelParams);
                }}
              >
                恢复默认
              </button>

              {isAdmin && (
                <button
                  type="button"
                  className="ai-prompt-modal-btn warning"
                  onClick={() => void onSaveAsGlobalDefault()}
                >
                  保存为默认值
                </button>
              )}

              <button
                type="button"
                className="ai-prompt-modal-btn primary"
                onClick={() => {
                  void (async () => {
                    await onSaveAndClose();
                    setOpen(false);
                  })();
                }}
              >
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ModelConfigModal;

