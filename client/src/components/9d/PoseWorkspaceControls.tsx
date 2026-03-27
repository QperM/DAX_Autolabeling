import React from 'react';
import type { Image } from '../../types';
import DepthUploader from './DepthUploader';
import MeshUploader from './MeshUploader';
import BatchDepthCompletionButton from './BatchDepthCompletionButton';
import { PoseAnnotationsZipExportButton } from './PoseAnnotationsZipExport';
import { ProgressPopupModal, type ProgressPopupBar } from '../common/ProgressPopupModal';

type MeshItem = {
  id?: number;
  filename: string;
  originalName: string;
  url: string;
  assetDirUrl?: string;
  assets?: string[];
  skuLabel?: string | null;
};

type Props = {
  currentProject: { id: number; name: string } | null;
  isAdmin: boolean;
  images: Image[];
  estimating6d: boolean;
  repairingDepth: boolean;
  batchProgress: { running: boolean; total: number; current: number; success: number; failed: number; timeout: number } | null;
  depthRepairPopupDismissed: boolean;
  depthRepairProgress: { totalImages: number; processedImages: number; doneImages: number; failedImages: number };
  singlePoseProgress: number;
  singlePoseProgressText: string;
  projectMeshes: MeshItem[];
  onDepthUploadComplete: () => void;
  onMeshUploadComplete: (meshes: MeshItem[]) => void;
  onOpenDiffDopeParams: () => void;
  onBatchEstimate6D: () => void;
  onBatchRepairDepth: () => void;
  onCloseBatchProgress: () => void;
  onDismissDepthRepairPopup: () => void;
  onOpenMeshLabelMapping: () => void;
};

const PoseWorkspaceControls: React.FC<Props> = ({
  currentProject,
  isAdmin,
  images,
  estimating6d,
  repairingDepth,
  batchProgress,
  depthRepairPopupDismissed,
  depthRepairProgress,
  singlePoseProgress,
  singlePoseProgressText,
  projectMeshes,
  onDepthUploadComplete,
  onMeshUploadComplete,
  onOpenDiffDopeParams,
  onBatchEstimate6D,
  onBatchRepairDepth,
  onCloseBatchProgress,
  onDismissDepthRepairPopup,
  onOpenMeshLabelMapping,
}) => {
  return (
    <div className="welcome-content pose-welcome-content">
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'stretch', justifyContent: 'space-between', minHeight: 130 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <DepthUploader
            projectId={currentProject?.id}
            disabled={!isAdmin}
            title={!isAdmin ? '当前账号为标注用户，不能上传 Depth / 点云数据。如需新增，请联系管理员。' : undefined}
            onUploadComplete={onDepthUploadComplete}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MeshUploader
            projectId={currentProject?.id}
            disabled={!isAdmin}
            title={!isAdmin ? '当前账号为标注用户，不能上传 Mesh / 资产。如需新增，请联系管理员。' : undefined}
            onUploadComplete={onMeshUploadComplete}
          />
        </div>
      </div>

      <div style={{ marginTop: '1rem', color: '#666', fontSize: '0.95rem' }}>
        <div className="ai-section">
          <div className="ai-controls">
            <button type="button" className="ai-model-config-btn" onClick={onOpenDiffDopeParams} title="调整拟合参数">
              调整拟合参数
            </button>
            <button
              type="button"
              className="ai-annotation-btn"
              onClick={onBatchEstimate6D}
              disabled={!isAdmin || estimating6d || images.length === 0}
              title={!isAdmin ? '普通用户已禁用：批量AI标注需要管理员权限' : '按图片顺序执行 AI 6D 标注；单张超时 5 分钟后跳过并继续下一张'}
            >
              {estimating6d ? '🤖 批量AI标注进行中...' : '🤖 批量AI标注'}
            </button>
            <BatchDepthCompletionButton
              running={repairingDepth}
              disabled={!isAdmin || !currentProject?.id || estimating6d || images.length === 0}
              onClick={onBatchRepairDepth}
              title={!isAdmin ? '普通用户已禁用：批量补全深度信息需要管理员权限' : '按图片顺序批量补全深度信息（调用 depthrepair-service，产物写入项目 depth 目录）'}
            />
            <ProgressPopupModal
              open={!!batchProgress}
              title={batchProgress?.running ? '批量AI标注进度' : '批量AI标注结果'}
              closable={!batchProgress?.running}
              onClose={onCloseBatchProgress}
              bars={[
                {
                  key: 'pose-batch',
                  title: '批量进度',
                  percent: batchProgress?.total ? (batchProgress.current / Math.max(1, batchProgress.total)) * 100 : 0,
                  currentText: batchProgress && batchProgress.total > 0 ? `当前：${batchProgress.current}/${batchProgress.total}` : undefined,
                } satisfies ProgressPopupBar,
              ]}
              summary={
                batchProgress ? <>成功 {batchProgress.success} / 失败 {batchProgress.failed} / 超时 {batchProgress.timeout}</> : undefined
              }
            />
            <ProgressPopupModal
              open={repairingDepth && !depthRepairPopupDismissed}
              title="批量补全深度信息"
              closable={!repairingDepth}
              onClose={onDismissDepthRepairPopup}
              bars={[
                {
                  key: 'depth-repair-batch',
                  title: '写入进度',
                  percent: depthRepairProgress.totalImages > 0 ? (depthRepairProgress.processedImages / depthRepairProgress.totalImages) * 100 : 0,
                  currentText:
                    depthRepairProgress.totalImages > 0
                      ? `已处理：${depthRepairProgress.processedImages}/${depthRepairProgress.totalImages}（完成:${depthRepairProgress.doneImages} 失败:${depthRepairProgress.failedImages}）`
                      : '正在处理并写入 Depth / Intrinsics…',
                } satisfies ProgressPopupBar,
              ]}
            />
            <ProgressPopupModal
              open={estimating6d && !batchProgress && !repairingDepth}
              title="AI 6D姿态标注"
              bars={[{ key: 'pose-single', title: '计算进度', percent: singlePoseProgress, currentText: singlePoseProgressText } satisfies ProgressPopupBar]}
            />
            <div className="import-export-buttons">
              <button
                type="button"
                className="label-mapping-btn"
                onClick={onOpenMeshLabelMapping}
                disabled={!currentProject}
                title="查看 / 编辑各 Mesh 的 SKU Label（缩略图与底部网格一致）"
              >
                🏷️ Mesh Label 对照表
              </button>
              <PoseAnnotationsZipExportButton
                className="ai-annotation-btn export-btn"
                project={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
                images={images}
                meshes={projectMeshes}
                isAdmin={isAdmin}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PoseWorkspaceControls;

