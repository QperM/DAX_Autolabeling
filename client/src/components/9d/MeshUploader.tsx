import React, { useRef, useState } from "react";
import { meshApi } from "../../services/api";
import { debugLog } from "../../utils/debugSettings";
import { ProgressPopupModal, type ProgressPopupBar } from "../common/ProgressPopupModal";
import { useAppAlert } from "../common/AppAlert";

type MeshRecord = {
  id?: number;
  filename: string;
  originalName: string;
  size?: number;
  url: string;
  assetDirUrl?: string;
  assets?: string[];
  skuLabel?: string | null;
};

type Props = {
  projectId?: number;
  onUploadComplete?: (meshes: MeshRecord[]) => void;
  disabled?: boolean;
  title?: string;
};

const MeshUploader: React.FC<Props> = ({ projectId, onUploadComplete, disabled, title }) => {
  const meshInputRef = useRef<HTMLInputElement | null>(null);
  const { alert } = useAppAlert();
  const [meshUploading, setMeshUploading] = useState(false);
  const [meshProgress, setMeshProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const ensureProject = () => {
    if (!projectId) {
      alert("请先在主页选择项目，再上传 6D 数据（Depth + Mesh）。");
      return false;
    }
    return true;
  };

  const handleSelectMesh = () => {
    if (!ensureProject()) return;
    meshInputRef.current?.click();
  };

  const handleMeshChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !projectId) return;

    setMeshUploading(true);
    setMeshProgress(0);
    debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] start upload', { projectId, count: files.length });
    try {
      const resp = await meshApi.uploadMeshes(files, projectId, (p) => setMeshProgress(p));
      if (!resp?.success) {
        alert("Mesh 上传失败，请稍后重试。");
        return;
      }
      onUploadComplete?.(resp.files || []);
      debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] upload success', { count: resp?.files?.length || 0 });
      await alert(`Mesh 上传完成：新增 ${resp?.files?.length || 0} 个模型文件记录。`);
    } catch (err: any) {
      console.error("[MeshUploader] uploadMeshes failed:", err);
      debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] upload error', err?.message || String(err));
      alert(err?.message || "Mesh 上传失败，请稍后重试。");
    } finally {
      setMeshUploading(false);
      setMeshProgress(null);
      setDragOver(false);
      if (meshInputRef.current) meshInputRef.current.value = "";
    }
  };

  const effectiveDisabled = Boolean(disabled) || !projectId;
  const effectiveTitle =
    effectiveDisabled && title
      ? title
      : effectiveDisabled
        ? '当前账号为标注用户，不能上传 Mesh / 点云数据。如需新增，请联系管理员。'
        : undefined;

  return (
    <div className="image-uploader" style={{ height: "100%" }}>
      {/* Mesh 上传区：橙色，表示“几何模型” */}
      <div
        className={`dropzone ${effectiveDisabled ? "disabled-dropzone" : ""}`}
        onClick={effectiveDisabled || meshUploading ? undefined : handleSelectMesh}
        title={effectiveTitle}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (effectiveDisabled || meshUploading) return;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (effectiveDisabled || meshUploading) return;
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (effectiveDisabled || meshUploading) return;
          const files = Array.from(e.dataTransfer.files || []);
          if (!files.length || !projectId) return;
          setMeshUploading(true);
          setMeshProgress(0);
          debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] drag upload start', { projectId, count: files.length });
          try {
            const resp = await meshApi.uploadMeshes(files, projectId, (p) => setMeshProgress(p));
            if (!resp?.success) {
              alert("Mesh 上传失败，请稍后重试。");
              return;
            }
            onUploadComplete?.(resp.files || []);
            debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] drag upload success', { count: resp?.files?.length || 0 });
            await alert(`Mesh 上传完成：新增 ${resp?.files?.length || 0} 个模型文件记录。`);
          } catch (err: any) {
            console.error("[MeshUploader] uploadMeshes failed:", err);
            debugLog('frontend', 'frontend9DMeshUpload', '[MeshUploader] drag upload error', err?.message || String(err));
            alert(err?.message || "Mesh 上传失败，请稍后重试。");
          } finally {
            setMeshUploading(false);
            setMeshProgress(null);
            setDragOver(false);
          }
        }}
        style={{
          marginTop: 0,
          borderColor: dragOver ? "#ea580c" : "#f97316",
          background: dragOver ? "rgba(249,115,22,0.08)" : undefined,
          height: "100%",
        }}
      >
        <input
          ref={meshInputRef}
          type="file"
          accept=".obj,.mtl,.png,.jpg,.jpeg,.webp,.exr"
          multiple
          style={{ display: "none" }}
          onChange={handleMeshChange}
        />
        <div className="upload-prompt">
          <p style={{ color: "#f97316" }}>
            {effectiveDisabled && disabled ? '当前账号不能上传 Mesh' : '上传 Mesh 资产 (OBJ + MTL + 贴图)'}
          </p>
          <p className="hint">
            单次请选择同一模型的所有相关文件（*.obj、*.mtl、贴图 PNG/JPG 等），后端会为本次上传创建独立文件夹进行归档。
          </p>
          {effectiveDisabled && !projectId && <p className="hint">请先在主页选择项目。</p>}
          {effectiveDisabled && disabled && <p className="hint">如需新增，请联系管理员在后台上传。</p>}
        </div>
      </div>

      <ProgressPopupModal
        open={meshUploading}
        title="Mesh 上传进度"
        bars={[
          {
            key: "mesh-upload",
            title: "上传进度",
            percent: meshProgress ?? 0,
          } satisfies ProgressPopupBar,
        ]}
        message={meshProgress !== null && meshUploading ? "正在上传中..." : undefined}
      />
    </div>
  );
};

export default MeshUploader;


