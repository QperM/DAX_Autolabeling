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

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      try {
        console.log('[MeshUploader] onDrop 接收到文件:', {
          projectId,
          count: acceptedFiles.length,
          names: acceptedFiles.map((f) => f.name),
        });
        if (!projectId) {
          alert('请先选择项目后再上传 Mesh（.obj）');
          return;
        }
        if (!acceptedFiles || acceptedFiles.length === 0) return;

        dispatch(setLoading(true));
        dispatch(setError(null));
        setUploadProgress(0);

        const isDepthName = (name: string) => /^(depth_raw_|depth_)/i.test(String(name || '').trim());
        const isMeshAssetExt = (name: string) => /\.(obj|mtl|png|jpg|jpeg|webp|bmp|tga|gif)$/i.test(String(name || ''));
        const isDepthExt = (name: string) => /\.(png|tif|tiff|npy)$/i.test(String(name || ''));

        // 规则：
        // - Mesh 资源：.obj/.mtl/贴图图片（但避免把 depth_*.png 当作贴图）
        // - Depth 数据：depth_*.png / depth_raw_*.npy / depth_*.tif
        const meshFiles = acceptedFiles.filter((f) => isMeshAssetExt(f.name) && !isDepthName(f.name));
        const depthFiles = acceptedFiles.filter((f) => isDepthExt(f.name) && isDepthName(f.name));

        console.log('[MeshUploader] 分类结果:', {
          meshFiles: meshFiles.map((f) => f.name),
          depthFiles: depthFiles.map((f) => f.name),
        });

        // 先上传 Mesh，再上传 Depth（如果都有的话）
        if (meshFiles.length > 0) {
          console.log('[MeshUploader] 开始上传 Mesh 文件:', meshFiles.map((f) => f.name));
          const resp = await meshApi.uploadMeshes(meshFiles, projectId, (pct) => setUploadProgress(pct));
          console.log('[MeshUploader] /api/meshes/upload 响应:', resp);
          const files = (resp?.files || []) as UploadedMesh[];
          setUploaded((prev) => [...files, ...prev]);
          console.log('[MeshUploader] 已记录 Mesh 到前端状态，数量:', files.length);
          if (onUploadComplete) onUploadComplete(files);
        }

        if (depthFiles.length > 0) {
          console.log('[MeshUploader] 开始上传 Depth 文件:', depthFiles.map((f) => f.name));
          const respDepth = await depthApi.uploadDepth(depthFiles, projectId, (pct) => setUploadProgress(pct));
          console.log('[MeshUploader] /api/depth/upload 响应:', respDepth);
          const depthList = (respDepth?.files || []) as UploadedDepth[];
          setUploadedDepth((prev) => [...depthList, ...prev]);
        }
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
    [dispatch, onUploadComplete, projectId]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    accept: {
      'text/plain': ['.obj', '.mtl', '.npy'],
      'application/octet-stream': ['.obj', '.mtl', '.npy'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
      'image/tiff': ['.tif', '.tiff'],
    },
  });

  return (
    <div className="image-uploader">
      <div {...getRootProps()} className={`dropzone ${isDragActive ? 'drag-active' : ''}`}>
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>释放文件以上传...</p>
        ) : (
          <div className="upload-prompt">
            <p>拖拽 Mesh 到此处，或点击选择文件</p>
            <p className="hint">支持 OBJ（.obj）Mesh 和深度图 PNG/TIFF、.npy 深度数据；RGB 图片仍在 2D 标注模块导入</p>
          </div>
        )}
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

