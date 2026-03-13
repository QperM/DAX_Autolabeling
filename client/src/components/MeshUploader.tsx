import React, { useCallback, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useDispatch } from 'react-redux';
import { depthApi, meshApi } from '../services/api';
import { setError, setLoading } from '../store/annotationSlice';

type UploadedMesh = {
  filename: string;
  originalName: string;
  url: string;
  size?: number;
};
type UploadedDepth = {
  filename: string;
  originalName: string;
  url: string;
  size?: number;
  role?: string;
  modality?: string;
};

interface MeshUploaderProps {
  projectId?: number | string;
  onUploadComplete?: (meshes: UploadedMesh[]) => void;
}

const MeshUploader: React.FC<MeshUploaderProps> = ({ projectId, onUploadComplete }) => {
  const dispatch = useDispatch();
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploaded, setUploaded] = useState<UploadedMesh[]>([]);
  const [uploadedDepth, setUploadedDepth] = useState<UploadedDepth[]>([]);

  const hasActiveProgress = useMemo(() => uploadProgress !== null, [uploadProgress]);

  const isDepthName = useCallback((name: string) => /^(depth_raw_|depth_)/i.test(String(name || '').trim()), []);
  const isMeshAssetExt = useCallback(
    (name: string) => /\.(obj|mtl|png|jpg|jpeg|webp|bmp|tga|gif)$/i.test(String(name || '')),
    []
  );
  const isDepthExt = useCallback((name: string) => /\.(png|tif|tiff|npy)$/i.test(String(name || '')), []);

  const uploadMeshes = useCallback(
    async (meshFiles: File[]) => {
      if (meshFiles.length === 0) return;
          console.log('[MeshUploader] 开始上传 Mesh 文件:', meshFiles.map((f) => f.name));
      const resp = await meshApi.uploadMeshes(meshFiles, projectId as any, (pct) => setUploadProgress(pct));
          console.log('[MeshUploader] /api/meshes/upload 响应:', resp);
          const files = (resp?.files || []) as UploadedMesh[];
          setUploaded((prev) => [...files, ...prev]);
          console.log('[MeshUploader] 已记录 Mesh 到前端状态，数量:', files.length);
          if (onUploadComplete) onUploadComplete(files);
    },
    [onUploadComplete, projectId]
  );

  const uploadDepth = useCallback(
    async (depthFiles: File[]) => {
      if (depthFiles.length === 0) return;
          console.log('[MeshUploader] 开始上传 Depth 文件:', depthFiles.map((f) => f.name));
      const respDepth = await depthApi.uploadDepth(depthFiles, projectId as any, (pct) => setUploadProgress(pct));
          console.log('[MeshUploader] /api/depth/upload 响应:', respDepth);
          const depthList = (respDepth?.files || []) as UploadedDepth[];
          setUploadedDepth((prev) => [...depthList, ...prev]);
    },
    [projectId]
  );

  const withUploadSession = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        if (!projectId) {
          alert('请先选择项目后再上传 Mesh/深度数据');
          return;
        }
        dispatch(setLoading(true));
        dispatch(setError(null));
        setUploadProgress(0);
        await fn();
      } catch (error: any) {
        console.error('❌ Mesh/Depth 上传失败:', error);
        console.error('❌ 详细错误响应:', error?.response?.data);
        const msg =
          error?.response?.data?.message ||
          error?.response?.data?.error ||
          error?.message ||
          'Mesh 上传失败';
        dispatch(setError(msg));
        alert(msg);
      } finally {
        setTimeout(() => setUploadProgress(null), 800);
        dispatch(setLoading(false));
      }
    },
    [dispatch, projectId]
  );

  const onDropMesh = useCallback(
    async (acceptedFiles: File[]) => {
      console.log('[MeshUploader] onDropMesh 接收到文件:', {
        projectId,
        count: acceptedFiles.length,
        names: acceptedFiles.map((f) => f.name),
      });
      if (!acceptedFiles || acceptedFiles.length === 0) return;
      const meshFiles = acceptedFiles.filter((f) => isMeshAssetExt(f.name) && !isDepthName(f.name));
      const depthLike = acceptedFiles.filter((f) => isDepthExt(f.name) && isDepthName(f.name));
      console.log('[MeshUploader] onDropMesh 分类结果:', {
        meshFiles: meshFiles.map((f) => f.name),
        ignoredDepthLike: depthLike.map((f) => f.name),
      });
      await withUploadSession(async () => {
        await uploadMeshes(meshFiles);
      });
    },
    [isDepthExt, isDepthName, isMeshAssetExt, projectId, uploadMeshes, withUploadSession]
  );

  const onDropDepth = useCallback(
    async (acceptedFiles: File[]) => {
      console.log('[MeshUploader] onDropDepth 接收到文件:', {
        projectId,
        count: acceptedFiles.length,
        names: acceptedFiles.map((f) => f.name),
      });
      if (!acceptedFiles || acceptedFiles.length === 0) return;
      const depthFiles = acceptedFiles.filter((f) => isDepthExt(f.name) && isDepthName(f.name));
      const meshLike = acceptedFiles.filter((f) => isMeshAssetExt(f.name) && !isDepthName(f.name));
      console.log('[MeshUploader] onDropDepth 分类结果:', {
        depthFiles: depthFiles.map((f) => f.name),
        ignoredMeshLike: meshLike.map((f) => f.name),
      });
      await withUploadSession(async () => {
        await uploadDepth(depthFiles);
      });
    },
    [isDepthExt, isDepthName, isMeshAssetExt, projectId, uploadDepth, withUploadSession]
  );

  const {
    getRootProps: getMeshRootProps,
    getInputProps: getMeshInputProps,
    isDragActive: isMeshDragActive,
  } = useDropzone({
    onDrop: onDropMesh,
    multiple: true,
    accept: {
      'text/plain': ['.obj', '.mtl'],
      'application/octet-stream': ['.obj', '.mtl'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
  });

  const {
    getRootProps: getDepthRootProps,
    getInputProps: getDepthInputProps,
    isDragActive: isDepthDragActive,
  } = useDropzone({
    onDrop: onDropDepth,
    multiple: true,
    accept: {
      'text/plain': ['.npy'],
      'application/octet-stream': ['.npy'],
      'image/png': ['.png'],
      'image/tiff': ['.tif', '.tiff'],
    },
  });

  return (
    <div className="image-uploader">
      <div className="mesh-depth-dropzones">
        <div
          {...getDepthRootProps()}
          className={`dropzone dropzone-depth ${isDepthDragActive ? 'drag-active' : ''}`}
        >
          <input {...getDepthInputProps()} />
          {isDepthDragActive ? (
            <p>释放深度数据以上传...</p>
        ) : (
          <div className="upload-prompt">
              <div className="dropzone-title">深度数据</div>
              <p>拖拽 depth_* 文件到此处，或点击选择文件</p>
              <p className="hint">支持：depth_*.png / depth_*.tif(f) / depth_raw_*.npy</p>
          </div>
        )}
        </div>

        <div
          {...getMeshRootProps()}
          className={`dropzone dropzone-mesh ${isMeshDragActive ? 'drag-active' : ''}`}
        >
          <input {...getMeshInputProps()} />
          {isMeshDragActive ? (
            <p>释放 Mesh 资源以上传...</p>
          ) : (
            <div className="upload-prompt">
              <div className="dropzone-title">Mesh 资源</div>
              <p>拖拽 OBJ/MTL/贴图 到此处，或点击选择文件</p>
              <p className="hint">支持：.obj + .mtl + 贴图（png/jpg/webp/bmp/tga/gif）</p>
            </div>
          )}
        </div>
      </div>

      {hasActiveProgress && (
        <div className="upload-progress-panel">
          {uploadProgress !== null && (
            <div className="upload-progress-row">
              <div className="upload-progress-title">上传进度</div>
              <div className="upload-progress-bar">
                <div className="upload-progress-fill" style={{ width: `${uploadProgress}%` }} />
              </div>
              <div className="upload-progress-pct">{uploadProgress}%</div>
            </div>
          )}
        </div>
      )}

      {uploaded.length > 0 && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.9rem', color: '#555' }}>
          <div style={{ marginBottom: '0.25rem', fontWeight: 600 }}>已上传 Mesh</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', maxHeight: 120, overflow: 'auto' }}>
            {uploaded.slice(0, 20).map((m) => (
              <li key={m.url}>
                {m.originalName || m.filename}
              </li>
            ))}
          </ul>
          {uploaded.length > 20 && <div style={{ marginTop: '0.25rem' }}>…共 {uploaded.length} 个</div>}
        </div>
      )}

      {uploadedDepth.length > 0 && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.9rem', color: '#555' }}>
          <div style={{ marginBottom: '0.25rem', fontWeight: 600 }}>已上传深度数据</div>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', maxHeight: 120, overflow: 'auto' }}>
            {uploadedDepth.slice(0, 20).map((d) => (
              <li key={d.url}>
                {(d.role ? `[${d.role}] ` : '') + (d.originalName || d.filename)}
              </li>
            ))}
          </ul>
          {uploadedDepth.length > 20 && <div style={{ marginTop: '0.25rem' }}>…共 {uploadedDepth.length} 个</div>}
        </div>
      )}
    </div>
  );
};

export default MeshUploader;

