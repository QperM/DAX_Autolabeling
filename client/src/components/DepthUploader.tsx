import React, { useCallback, useRef, useState } from "react";
import { depthApi } from "../services/api";

type Props = {
  projectId?: number;
};

const DepthUploader: React.FC<Props> = ({ projectId }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const disabled = !projectId;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || !projectId) return;
      if (uploading) return;

      setUploading(true);
      setProgress(0);
      try {
        await depthApi.uploadDepth(files, projectId, (p) => setProgress(p));
      } catch (err: any) {
        console.error("[DepthUploader] uploadDepth failed:", err);
        alert(err?.message || "Depth 上传失败，请稍后重试。");
      } finally {
        setUploading(false);
        setProgress(null);
        setDragOver(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [projectId, uploading],
  );

  const handleClick = () => {
    if (!projectId) {
      alert("请先在主页选择项目，再上传 Depth / 点云数据。");
      return;
    }
    if (uploading) return;
    inputRef.current?.click();
  };

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files || []);
    await uploadFiles(files);
  };

  return (
    <div className="image-uploader" style={{ height: "100%" }}>
      <div
        className={`dropzone ${disabled ? "disabled-dropzone" : ""}`}
        onClick={disabled || uploading ? undefined : handleClick}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled || uploading) return;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled || uploading) return;
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
          if (disabled || uploading) return;
          const files = Array.from(e.dataTransfer.files || []);
          await uploadFiles(files);
        }}
        style={{
          borderColor: dragOver ? "#0284c7" : "#0ea5e9",
          background: dragOver ? "rgba(14,165,233,0.08)" : undefined,
          height: "100%",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".npy,.png,.tif,.tiff,.json"
          multiple
          style={{ display: "none" }}
          onChange={handleChange}
        />
        <div className="upload-prompt">
          <p style={{ color: "#0ea5e9" }}>上传 Depth / 点云输入</p>
          <p className="hint">支持一次性拖拽上传：depth_raw(.npy)、depth_png(.png/.tif)、intrinsics_*.json（相机内参）</p>
          <p className="hint" style={{ opacity: 0.9 }}>
            命名示例：depth_head_0.png / depth_raw_head_0.npy / intrinsics_head.json（role=head/right/left）
          </p>
          {uploading && <p className="hint">上传中… {progress ?? 0}%</p>}
          {!projectId && <p className="hint">请先在主页选择项目。</p>}
        </div>
      </div>
    </div>
  );
};

export default DepthUploader;

