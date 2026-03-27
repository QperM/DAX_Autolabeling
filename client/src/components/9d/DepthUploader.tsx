import React, { useCallback, useRef, useState } from "react";
import { depthApi } from "../../services/api";
import { debugLog } from "../../utils/debugSettings";
import { ProgressPopupModal, type ProgressPopupBar } from "../common/ProgressPopupModal";
import { useAppAlert } from "../common/AppAlert";

type Props = {
  projectId?: number;
  disabled?: boolean;
  title?: string;
  onUploadComplete?: () => void;
};

const DepthUploader: React.FC<Props> = ({ projectId, disabled, title, onUploadComplete }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { alert } = useAppAlert();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const effectiveDisabled = Boolean(disabled) || !projectId;
  const effectiveTitle =
    effectiveDisabled && title
      ? title
      : effectiveDisabled
        ? '当前账号为标注用户，不能上传 Depth / 点云数据。如需新增，请联系管理员。'
        : undefined;

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || !projectId) return;
      if (uploading) return;

      setUploading(true);
      setProgress(0);
      debugLog('frontend', 'frontend9DDepthUpload', '[DepthUploader] start upload', { projectId, count: files.length });
      try {
        await depthApi.uploadDepth(files, projectId, (p) => setProgress(p));
        debugLog('frontend', 'frontend9DDepthUpload', '[DepthUploader] upload success', { projectId, count: files.length });
        await alert(`Depth 上传完成：${files.length} 个文件已处理。`);
        if (onUploadComplete) onUploadComplete();
      } catch (err: any) {
        console.error("[DepthUploader] uploadDepth failed:", err);
        debugLog('frontend', 'frontend9DDepthUpload', '[DepthUploader] upload error', err?.message || String(err));
        const message =
          err?.response?.data?.message ||
          err?.message ||
          "Depth 上传失败，请稍后重试。";
        alert(message);
      } finally {
        setUploading(false);
        setProgress(null);
        setDragOver(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [projectId, uploading, onUploadComplete],
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
        className={`dropzone ${effectiveDisabled ? "disabled-dropzone" : ""}`}
        onClick={effectiveDisabled || uploading ? undefined : handleClick}
        title={effectiveTitle}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (effectiveDisabled || uploading) return;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (effectiveDisabled || uploading) return;
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
          if (effectiveDisabled || uploading) return;
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
          accept=".npy,.png,.tif,.tiff,.json,.zip,.7z"
          multiple
          style={{ display: "none" }}
          onChange={handleChange}
        />
        <div className="upload-prompt">
          <p style={{ color: "#0ea5e9" }}>{effectiveDisabled ? '当前账号不能上传' : '上传 Depth / 点云输入'}</p>
          <p className="hint">支持一次性拖拽上传：depth_raw(.npy)、depth_png(.png/.tif)、intrinsics_*.json（相机内参）</p>
          <p className="hint" style={{ opacity: 0.9 }}>
            也支持压缩包：.zip / .7z（压缩包内仅允许上述 Depth/Intrinsics 文件，其它文件将报错并撤回上传）
          </p>
          <p className="hint" style={{ opacity: 0.9 }}>
            命名示例：depth_head_0.png / depth_raw_head_0.npy / intrinsics_head.json（role=head/right/left）
          </p>
          {effectiveDisabled && projectId === undefined && <p className="hint">请先在主页选择项目。</p>}
          {effectiveDisabled && disabled && <p className="hint">如需新增，请联系管理员在后台上传。</p>}
        </div>
      </div>

      <ProgressPopupModal
        open={uploading}
        title="Depth 上传进度"
        bars={[
          {
            key: "depth-upload",
            title: "上传进度",
            percent: progress ?? 0,
          } satisfies ProgressPopupBar,
        ]}
        message={progress !== null && uploading ? "正在上传中..." : undefined}
      />
    </div>
  );
};

export default DepthUploader;

