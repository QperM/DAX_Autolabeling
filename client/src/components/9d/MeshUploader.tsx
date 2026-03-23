import React, { useRef, useState } from "react";
import { meshApi } from "../../services/api";

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
};

const MeshUploader: React.FC<Props> = ({ projectId, onUploadComplete }) => {
  const meshInputRef = useRef<HTMLInputElement | null>(null);
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
    try {
      const resp = await meshApi.uploadMeshes(files, projectId, (p) => setMeshProgress(p));
      if (!resp?.success) {
        alert("Mesh 上传失败，请稍后重试。");
        return;
      }
      onUploadComplete?.(resp.files || []);
    } catch (err: any) {
      console.error("[MeshUploader] uploadMeshes failed:", err);
      alert(err?.message || "Mesh 上传失败，请稍后重试。");
    } finally {
      setMeshUploading(false);
      setMeshProgress(null);
      setDragOver(false);
      if (meshInputRef.current) meshInputRef.current.value = "";
    }
  };

  const disabled = !projectId;

  return (
    <div className="image-uploader" style={{ height: "100%" }}>
      {/* Mesh 上传区：橙色，表示“几何模型” */}
      <div
        className={`dropzone ${disabled ? "disabled-dropzone" : ""}`}
        onClick={disabled || meshUploading ? undefined : handleSelectMesh}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled || meshUploading) return;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled || meshUploading) return;
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
          if (disabled || meshUploading) return;
          const files = Array.from(e.dataTransfer.files || []);
          if (!files.length || !projectId) return;
          setMeshUploading(true);
          setMeshProgress(0);
          try {
            const resp = await meshApi.uploadMeshes(files, projectId, (p) => setMeshProgress(p));
            if (!resp?.success) {
              alert("Mesh 上传失败，请稍后重试。");
              return;
            }
            onUploadComplete?.(resp.files || []);
          } catch (err: any) {
            console.error("[MeshUploader] uploadMeshes failed:", err);
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
          <p style={{ color: "#f97316" }}>上传 Mesh 资产 (OBJ + MTL + 贴图)</p>
          <p className="hint">
            单次请选择同一模型的所有相关文件（*.obj、*.mtl、贴图 PNG/JPG 等），后端会为本次上传创建独立文件夹进行归档。
          </p>
          {meshUploading && (
            <p className="hint">上传中… {meshProgress ?? 0}%</p>
          )}
          {!projectId && <p className="hint">请先在主页选择项目。</p>}
        </div>
      </div>
    </div>
  );
};

export default MeshUploader;


