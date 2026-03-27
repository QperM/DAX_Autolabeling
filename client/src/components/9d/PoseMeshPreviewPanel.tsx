import React from 'react';
import MeshPreview3D from './MeshPreview3D';

type MeshItem = {
  id?: number;
  filename: string;
  originalName: string;
  url: string;
  assetDirUrl?: string;
  assets?: string[];
};

type Props = {
  selectedPreviewMesh: MeshItem | null;
  projectMeshes: MeshItem[];
  meshPreviewTextureEnabled: boolean;
  meshPreviewDims: { x: number; y: number; z: number } | null;
  isAdmin: boolean;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
  onToggleTexture: () => void;
  onMeshBoundsChange: (size: { x: number; y: number; z: number } | null) => void;
  onDeleteMesh: () => void;
};

const fmtCmFromMeters = (v: number) => {
  if (!Number.isFinite(v)) return '-';
  const cm = v * 100;
  const n = Math.round(cm * 100) / 100;
  return String(n).replace(/\.0$/, '');
};

const PoseMeshPreviewPanel: React.FC<Props> = ({
  selectedPreviewMesh,
  projectMeshes,
  meshPreviewTextureEnabled,
  meshPreviewDims,
  isAdmin,
  onClose,
  onNavigate,
  onToggleTexture,
  onMeshBoundsChange,
  onDeleteMesh,
}) => {
  if (!selectedPreviewMesh) {
    return (
      <div className="no-preview-selected">
        <div className="preview-placeholder">
          <span className="preview-icon">🧊</span>
          <p>点击下方 Mesh 缩略图进行预览</p>
        </div>
      </div>
    );
  }

  const curIdx = projectMeshes.findIndex((m) => m.id === selectedPreviewMesh.id);

  return (
    <div className="image-preview-container">
      <div className="preview-header">
        <h3>{selectedPreviewMesh.originalName || selectedPreviewMesh.filename}</h3>
        <button className="close-preview-btn" onClick={onClose}>×</button>
      </div>
      <div className="image-preview-wrapper" style={{ position: 'relative' }}>
        <div className="preview-image-layer" style={{ width: '100%', height: '100%' }}>
          <MeshPreview3D
            meshUrl={selectedPreviewMesh.url || null}
            assetDirUrl={selectedPreviewMesh.assetDirUrl || undefined}
            assets={selectedPreviewMesh.assets}
            enableTexture={meshPreviewTextureEnabled}
            onMeshBoundsChange={onMeshBoundsChange}
          />
        </div>
        <button
          type="button"
          onClick={onToggleTexture}
          title={meshPreviewTextureEnabled ? '已加载贴图（点击关闭）' : '未加载贴图（点击开启）'}
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            zIndex: 10,
            padding: '0.35rem 0.55rem',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.18)',
            background: meshPreviewTextureEnabled ? 'rgba(34,197,94,0.22)' : 'rgba(148,163,184,0.22)',
            color: '#e5e7eb',
            fontSize: '0.85rem',
            cursor: 'pointer',
            backdropFilter: 'blur(6px)',
          }}
        >
          {meshPreviewTextureEnabled ? 'Texture: ON' : 'Texture: OFF'}
        </button>
        {meshPreviewDims && (
          <div className="mesh-dims-panel" style={{ position: 'absolute', top: 48, left: 10, zIndex: 10 }}>
            <div>长（x）：{fmtCmFromMeters(meshPreviewDims.x)} cm</div>
            <div>高（y）：{fmtCmFromMeters(meshPreviewDims.y)} cm</div>
            <div>宽（z）：{fmtCmFromMeters(meshPreviewDims.z)} cm</div>
          </div>
        )}
      </div>
      <div className="preview-actions">
        <button
          className="nav-image-btn prev-image-btn"
          onClick={() => onNavigate('prev')}
          disabled={!selectedPreviewMesh?.id || curIdx <= 0}
        >
          ← 上一个
        </button>
        {isAdmin && (
          <button
            type="button"
            className="secondary-button"
            style={{ background: '#dc2626', borderColor: '#b91c1c', color: '#fff' }}
            onClick={onDeleteMesh}
            title="删除该 Mesh（会同时删除其 9D Pose 记录）"
          >
            删除 Mesh
          </button>
        )}
        <button
          className="nav-image-btn next-image-btn"
          onClick={() => onNavigate('next')}
          disabled={!selectedPreviewMesh?.id || curIdx === projectMeshes.length - 1}
        >
          下一个 →
        </button>
      </div>
    </div>
  );
};

export default PoseMeshPreviewPanel;

