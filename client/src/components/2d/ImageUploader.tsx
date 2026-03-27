import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useDispatch } from 'react-redux';
import { imageApi, uploadJobApi } from '../../services/api';
import { addImage, setLoading, setError } from '../../store/annotationSlice';
import type { Image } from '../../types';
import { debugLog } from '../../utils/debugSettings';
import { ProgressPopupModal, type ProgressPopupBar } from '../common/ProgressPopupModal';
import { useAppAlert } from '../common/AppAlert';

interface ImageUploaderProps {
  onUploadComplete?: (images: Image[]) => void;
  projectId?: number | string;
}

const ImageUploader: React.FC<ImageUploaderProps> = ({ onUploadComplete, projectId }) => {
  const dispatch = useDispatch();
  const { alert } = useAppAlert();
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [extractJobId, setExtractJobId] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState<number | null>(null);
  const [extractMessage, setExtractMessage] = useState<string>('');
  const [extracting, setExtracting] = useState(false);
  const pollTimerRef = useRef<any>(null);

  const hasActiveProgress = useMemo(() => {
    return uploadProgress !== null || extracting;
  }, [uploadProgress, extracting]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const startPollJob = (jobId: string) => {
    setExtractJobId(jobId);
    setExtracting(true);
    setExtractProgress(0);
    setExtractMessage('等待解压...');

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    pollTimerRef.current = setInterval(async () => {
      try {
        const resp = await uploadJobApi.getJob(jobId);
        const job = resp?.job;
        if (!job) return;

        setExtractMessage(job.message || '');
        setExtractProgress(typeof job.progress === 'number' ? job.progress : 0);

        if (job.status === 'completed') {
          // 将解压出的图片加入 Redux
          const newImages: Image[] = job.files || [];
          newImages.forEach((img) => dispatch(addImage(img)));

          if (onUploadComplete) {
            onUploadComplete(newImages);
          }

          setExtracting(false);
          setExtractProgress(100);
          setTimeout(() => {
            setExtractProgress(null);
            setExtractMessage('');
            setExtractJobId(null);
          }, 1200);

          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }

        if (job.status === 'error') {
          setExtracting(false);
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          alert(`解压失败：${job.error || '未知错误'}`);
        }
      } catch (e: any) {
        console.warn('[ImageUploader] 轮询解压进度失败:', e);
      }
    }, 600);
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    try {
      if (!projectId) {
        debugLog('frontend', 'frontend2DUpload', '[ImageUploader] missing projectId');
        alert('请先选择项目后再上传图片');
        return;
      }

      const MAX_FILES_PER_UPLOAD = 2000;
      if (acceptedFiles.length > MAX_FILES_PER_UPLOAD) {
        alert(`一次性上传的图片数量过多：当前选择了 ${acceptedFiles.length} 个文件，单次最多支持 ${MAX_FILES_PER_UPLOAD} 个。\n\n请分批上传，每次不超过 ${MAX_FILES_PER_UPLOAD} 张图片。`);
        return;
      }

      dispatch(setLoading(true));
      dispatch(setError(null));
      setUploadProgress(0);
      debugLog('frontend', 'frontend2DUpload', '[ImageUploader] start upload', { projectId, count: acceptedFiles.length });
      
      // 上传文件到服务器
      const response = await imageApi.uploadImages(acceptedFiles, projectId, (pct) => {
        setUploadProgress(pct);
      });
      debugLog('frontend', 'frontend2DUpload', '[ImageUploader] upload response', { files: response?.files?.length || 0, zipJobs: response?.zipJobs?.length || 0 });
      
      // 将上传的图像添加到状态中
      response.files.forEach(image => {
        dispatch(addImage(image));
      });
      
      if (onUploadComplete) {
        onUploadComplete(response.files);
      }

      // ZIP 解压进度（如果有）
      if (response.zipJobs && response.zipJobs.length > 0) {
        // 目前先支持单个 job（如需支持多个，可扩展为列表）
        startPollJob(response.zipJobs[0].jobId);
      }
      
    } catch (error: any) {
      console.error('❌ 上传失败:', error);
      debugLog('frontend', 'frontend2DUpload', '[ImageUploader] upload error', error?.message || String(error));
      const serverMessage =
        error?.response?.data?.message ||
        error.message ||
        '文件上传失败';
      dispatch(setError(serverMessage));
      alert(serverMessage);
    } finally {
      setTimeout(() => setUploadProgress(null), 800);
      dispatch(setLoading(false));
    }
  }, [dispatch, onUploadComplete, projectId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true, // 一次可拖拽 / 选择多张图片或多个 ZIP
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.webp'],
      'application/zip': ['.zip'],
      'application/x-zip-compressed': ['.zip'],
      // Windows 上 7z 常见 mime；加上后文件选择器才能看到 .7z
      'application/x-7z-compressed': ['.7z'],
      // 某些环境会把 7z 识别为 octet-stream
      'application/octet-stream': ['.7z'],
    },
    // 移除文件数量限制，支持大量文件上传
    // maxFiles: 50,
    // 移除文件大小限制
  });

  return (
    <div className="image-uploader">
      <div 
        {...getRootProps()} 
        className={`dropzone ${isDragActive ? 'drag-active' : ''}`}
      >
        <input {...getInputProps()} />
        {isDragActive ? (
          <p>释放文件以上传...</p>
        ) : (
          <div className="upload-prompt">
            <p>拖拽图片到此处，或点击选择文件</p>
            <p className="hint">支持 JPG、PNG、GIF、TIFF、WebP 格式图片和 ZIP 压缩包，支持大量文件批量上传</p>
          </div>
        )}
      </div>

      <ProgressPopupModal
        open={hasActiveProgress}
        title="图片上传 / 解压进度"
        bars={(() => {
          const bars: ProgressPopupBar[] = [];
          if (uploadProgress !== null) {
            bars.push({
              key: 'upload',
              title: '上传进度',
              percent: uploadProgress,
              tone: 'primary',
            });
          }

          if (extracting || extractProgress !== null) {
            bars.push({
              key: 'extract',
              title: '解压进度',
              percent: extractProgress ?? 0,
              tone: 'extract',
            });
          }

          return bars;
        })()}
        message={
          extractMessage
            ? `${extractMessage}${extractJobId ? `（${extractJobId}）` : ''}`
            : undefined
        }
      />
    </div>
  );
};

export default ImageUploader;