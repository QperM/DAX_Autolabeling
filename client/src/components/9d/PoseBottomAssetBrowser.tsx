import React from 'react';
import type { Image } from '../../types';
import { toAbsoluteUrl } from '../../utils/urls';
import MeshThumbnail from './MeshThumbnail';
import VirtualThumbGrid from '../common/VirtualThumbGrid';

type BottomViewMode = 'images' | 'meshes' | 'intrinsics' | 'depth';

type MeshItem = {
  id?: number;
  filename: string;
  originalName: string;
  url: string;
  assetDirUrl?: string;
  assets?: string[];
};

type CameraItem = { id: number; role: string; intrinsicsOriginalName?: string | null };
type DepthGroupEntry = { depthId: number; kind: string; filename: string };
type DepthGroupView = { key: string; entries: DepthGroupEntry[] };

type Props = {
  currentProject: { id: number; name: string } | null;
  bottomViewMode: BottomViewMode;
  setBottomViewMode: (mode: BottomViewMode) => void;
  images: Image[];
  imageCacheBust: number;
  THUMB_SIZE: number;
  THUMB_GAP: number;
  projectMeshes: MeshItem[];
  projectIntrinsicsRows: CameraItem[];
  depthGroups: DepthGroupView[];
  displayedDepthRowsCount: number;
  selectedPreviewImage: Image | null;
  selectedPreviewMesh: MeshItem | null;
  selectedCameraId: number | null;
  selectedDepthId: number | null;
  onSelectPreviewImage: (img: Image) => void;
  onSelectPreviewMesh: (mesh: MeshItem) => void;
  onSelectCamera: (cameraId: number) => void;
  onSelectDepthGroup: (depthId: number | null) => void;
};

const PoseBottomAssetBrowser: React.FC<Props> = ({
  currentProject,
  bottomViewMode,
  setBottomViewMode,
  images,
  imageCacheBust,
  THUMB_SIZE,
  THUMB_GAP,
  projectMeshes,
  projectIntrinsicsRows,
  depthGroups,
  displayedDepthRowsCount,
  selectedPreviewImage,
  selectedPreviewMesh,
  selectedCameraId,
  selectedDepthId,
  onSelectPreviewImage,
  onSelectPreviewMesh,
  onSelectCamera,
  onSelectDepthGroup,
}) => {
  if (!currentProject) return null;

  return (
    <div className="welcome-bottom">
      <div className="uploaded-images-preview">
        <div className="preview-header uploaded-preview-header">
          <h3>
            {bottomViewMode === 'images'
              ? `项目图片(${images.length})`
              : bottomViewMode === 'meshes'
                ? `项目 Mesh 资产（${projectMeshes.length})`
                : bottomViewMode === 'intrinsics'
                  ? `相机内参（${projectIntrinsicsRows.length})`
                  : `深度数据（${displayedDepthRowsCount})`}
          </h3>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
            <button type="button" className={`nav-image-btn ${bottomViewMode === 'images' ? 'prev-image-btn' : ''}`} style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }} onClick={() => setBottomViewMode('images')}>图片</button>
            <button type="button" className={`nav-image-btn ${bottomViewMode === 'meshes' ? 'next-image-btn' : ''}`} style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }} onClick={() => setBottomViewMode('meshes')}>Mesh</button>
            <button type="button" className={`nav-image-btn ${bottomViewMode === 'intrinsics' ? 'next-image-btn' : ''}`} style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }} onClick={() => setBottomViewMode('intrinsics')} title="查看项目相机内参，并支持删除">内参</button>
            <button type="button" className={`nav-image-btn ${bottomViewMode === 'depth' ? 'next-image-btn' : ''}`} style={{ padding: '0.35rem 0.9rem', minWidth: 'auto', fontSize: '0.85rem' }} onClick={() => setBottomViewMode('depth')} title="查看当前图深度数据，并支持删除">深度</button>
          </div>
          <div className="project-info">
            <span className="project-name">项目: {currentProject.name}</span>
            <span className="project-id">ID: {currentProject.id}</span>
          </div>
        </div>

        {bottomViewMode === 'images' ? (
          <VirtualThumbGrid
            items={images}
            getId={(img) => img.id}
            selectedId={selectedPreviewImage?.id ?? null}
            thumbSize={THUMB_SIZE}
            thumbGap={THUMB_GAP}
            onSelect={onSelectPreviewImage}
            renderTile={({ item: image }) => (
              <>
                <div className="thumbnail-image-layer">
                  <img
                    src={`${(toAbsoluteUrl(image.url) || image.url)}?v=${imageCacheBust}`}
                    alt={image.originalName || image.filename}
                  />
                </div>
                <div className="thumbnail-overlay">
                  <span className="thumbnail-name">{image.originalName || image.filename}</span>
                </div>
              </>
            )}
          />
        ) : bottomViewMode === 'meshes' ? (
          projectMeshes.length === 0 ? (
            <div style={{ padding: '1.5rem', fontSize: '0.9rem', color: '#777' }}>当前项目暂无已上传的 Mesh</div>
          ) : (
            <VirtualThumbGrid
              items={projectMeshes}
              getId={(m) => m.id ?? m.filename}
              selectedId={selectedPreviewMesh?.id ?? null}
              thumbSize={THUMB_SIZE}
              thumbGap={THUMB_GAP}
              onSelect={onSelectPreviewMesh}
              renderTile={({ item: m }) => (
                <>
                  <div className="thumbnail-image-layer" title={m.originalName || m.filename}>
                    <MeshThumbnail meshUrl={m.url || null} label={m.originalName || m.filename} assetDirUrl={m.assetDirUrl || undefined} assets={m.assets} />
                  </div>
                  <div className="thumbnail-overlay">
                    <span className="thumbnail-name">{m.originalName || m.filename}</span>
                  </div>
                </>
              )}
            />
          )
        ) : bottomViewMode === 'intrinsics' ? (
          projectIntrinsicsRows.length === 0 ? (
            <div className="pose-depth-empty">当前项目暂无相机内参，请先上传 `intrinsics_*.json`。</div>
          ) : (
            <VirtualThumbGrid
              items={projectIntrinsicsRows}
              getId={(cam) => cam.id}
              selectedId={selectedCameraId}
              thumbSize={THUMB_SIZE}
              thumbGap={THUMB_GAP}
              onSelect={(cam) => onSelectCamera(cam.id)}
              getTileClassName={() => 'pose-file-card'}
              renderTile={({ item: cam }) => (
                <div
                  title={cam.intrinsicsOriginalName || `intrinsics_${cam.role}.json`}
                  style={{ height: '100%' }}
                >
                  <div className="pose-file-card-emoji">📷</div>
                  <div className="pose-file-card-title">
                    {cam.intrinsicsOriginalName || `intrinsics_${cam.role}.json`}
                  </div>
                  <div className="pose-file-card-files">
                    <div className="pose-file-card-fileline">{`camera #${cam.id}`}</div>
                  </div>
                </div>
              )}
            />
          )
        ) : depthGroups.length === 0 ? (
          <div className="pose-depth-empty">当前项目暂无深度数据。</div>
        ) : (
          <VirtualThumbGrid
            items={depthGroups}
            getId={(g) => g.key}
            selectedId={
              selectedDepthId != null
                ? depthGroups.find((g) => g.entries.some((f) => Number(f.depthId) === Number(selectedDepthId)))?.key ?? null
                : null
            }
            thumbSize={THUMB_SIZE}
            thumbGap={THUMB_GAP}
            onSelect={(g) => onSelectDepthGroup(g.entries[0] ? Number(g.entries[0].depthId) : null)}
            getTileClassName={() => 'pose-file-card'}
            renderTile={({ item: g }) => (
              <div title={g.entries.map((f) => f.filename).join('\n')} style={{ height: '100%' }}>
                <div className="pose-file-card-emoji">🧭</div>
                <div className="pose-file-card-title">{g.key || '未命名'}</div>
                <div className="pose-file-card-files">
                  {g.entries.map((f) => (
                    <div key={`${g.key}-${f.kind}-${f.filename}`} className="pose-file-card-fileline">{f.filename}</div>
                  ))}
                </div>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
};

export default PoseBottomAssetBrowser;

