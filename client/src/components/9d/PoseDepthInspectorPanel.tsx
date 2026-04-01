import React from 'react';

type DepthItem = {
  id: number | null;
  filename: string;
  originalName?: string | null;
  url: string;
  role?: string;
  modality?: string;
  uploadTime?: string;
  imageId?: number | null;
  cameraId?: number | null;
  depthRawFixUrl?: string | null;
  depthPngFixUrl?: string | null;
};

export type DepthEntry = {
  depthId: number;
  kind: 'depth_png' | 'depth_raw' | 'depth_png_fix' | 'depth_raw_fix';
  filename: string;
};

type CameraItem = {
  id: number;
  role: string;
  intrinsics: any;
  intrinsicsFileSize?: number | null;
  intrinsicsOriginalName?: string | null;
  updatedAt?: string | null;
};

type Props = {
  mode: 'depth' | 'intrinsics';
  selectedImageName?: string | null;
  selectedRgbOriginalName?: string | null;
  selectedDepth: DepthItem | null;
  selectedCamera: CameraItem | null;
  selectedDepthEntries?: DepthEntry[];
  loading: boolean;
  deleting: boolean;
  canDelete: boolean;
  onDeleteDepth: () => void;
  onDeleteDepthEntry?: (entry: DepthEntry) => void;
  onDeleteCamera: () => void;
};

const prettyBytes = (n?: number | null) => {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return '-';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
};

const fmtDate = (v?: string | null) => {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
};

const PoseDepthInspectorPanel: React.FC<Props> = ({
  mode,
  selectedImageName,
  selectedRgbOriginalName,
  selectedDepth,
  selectedCamera,
  selectedDepthEntries,
  loading,
  deleting,
  canDelete,
  onDeleteDepth,
  onDeleteDepthEntry,
  onDeleteCamera,
}) => {
  if (mode === 'intrinsics') {
    return (
      <div className="image-preview-container">
        <div className="preview-header">
          <h3>相机内参预览</h3>
        </div>
        {!selectedCamera ? (
          <div className="no-preview-selected">
            <div className="preview-placeholder">
              <span className="preview-icon">📷</span>
              <p>请在下方选择一个相机内参</p>
            </div>
          </div>
        ) : (
          <>
            <div className="pose-depth-inspector">
              <div className="pose-depth-inspector-meta">
                <div><strong>Role:</strong> {selectedCamera.role || '-'}</div>
                <div>
                  <strong>原始文件名:</strong> {selectedCamera.intrinsicsOriginalName || `intrinsics_${selectedCamera.role}.json`}
                </div>
                <div><strong>更新时间:</strong> {fmtDate(selectedCamera.updatedAt)}</div>
                <div><strong>文件大小:</strong> {prettyBytes(selectedCamera.intrinsicsFileSize)}</div>
              </div>
              <pre className="pose-depth-inspector-pre">
                {JSON.stringify(selectedCamera.intrinsics || {}, null, 2)}
              </pre>
            </div>
            <div className="preview-actions">
              <div />
              {canDelete && (
                <button
                  type="button"
                  className="secondary-button"
                  style={{ background: '#dc2626', borderColor: '#b91c1c', color: '#fff' }}
                  disabled={deleting}
                  onClick={onDeleteCamera}
                  title="删除该相机内参（camera）记录"
                >
                  {deleting ? '删除中...' : '删除内参'}
                </button>
              )}
              <div />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="image-preview-container">
      <div className="preview-header">
        <h3>深度信息预览</h3>
      </div>
      {!selectedDepth ? (
        <div className="no-preview-selected">
          <div className="preview-placeholder">
            <span className="preview-icon">🧭</span>
            <p>请在下方选择一个深度文件</p>
          </div>
        </div>
      ) : (
        <>
          <div className="pose-depth-inspector">
            <div className="pose-depth-inspector-meta">
              <div><strong>图片:</strong> {selectedDepth.imageId == null ? '未绑定图片' : (selectedImageName || `image#${selectedDepth.imageId}`)}</div>
              <div><strong>RGB原文件名:</strong> {selectedDepth.imageId == null ? '-' : (selectedRgbOriginalName || (selectedImageName || `image#${selectedDepth.imageId}`))}</div>
              <div><strong>Role:</strong> {selectedDepth.role || '-'}</div>
              <div>
                <strong>原始文件名:</strong> {selectedDepth.originalName || '-'}
              </div>
              <div>
                <strong>磁盘文件名:</strong> {selectedDepth.filename || '-'}
              </div>
              <div><strong>更新时间:</strong> {fmtDate(selectedDepth.uploadTime)}</div>
            </div>
            <div className="pose-depth-inspector-note">
              当前分组文件（可逐条删除）：
            </div>
            <div className="pose-depth-entry-list">
              {(selectedDepthEntries || []).map((entry) => (
                <div key={`${entry.depthId}-${entry.kind}-${entry.filename}`} className="pose-depth-entry-row">
                  <span className="pose-depth-entry-kind">{entry.kind}</span>
                  <span className="pose-depth-entry-name">{entry.filename}</span>
                  {canDelete && onDeleteDepthEntry && (
                    <button
                      type="button"
                      className="secondary-button pose-depth-entry-delete-btn"
                      disabled={deleting}
                      onClick={() => onDeleteDepthEntry(entry)}
                      title={`删除 ${entry.filename}`}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="preview-actions">
            <div />
            {canDelete && (
              <button
                type="button"
                className="secondary-button"
                style={{ background: '#dc2626', borderColor: '#b91c1c', color: '#fff' }}
                disabled={deleting || loading}
                onClick={onDeleteDepth}
                title="删除该深度文件记录（并清理对应文件）"
              >
                {deleting ? '删除中...' : '删除深度'}
              </button>
            )}
            <div />
          </div>
        </>
      )}
    </div>
  );
};

export default PoseDepthInspectorPanel;
