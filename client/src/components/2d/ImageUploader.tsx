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
  const [activeStageKind, setActiveStageKind] = useState<'extract' | 'ingest'>('extract');
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

  const pollJobToCompletion = (jobId: string, kind: 'extract' | 'ingest'): Promise<Image[]> => {
    setActiveStageKind(kind);
    setExtractJobId(jobId);
    setExtracting(true);
    setExtractProgress(0);
    setExtractMessage(kind === 'ingest' ? '等待入库...' : '等待解压...');

    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }

    return new Promise<Image[]>((resolve, reject) => {
      pollTimerRef.current = setInterval(async () => {
        try {
          const resp = await uploadJobApi.getJob(jobId);
          const job = resp?.job;
          if (!job) return;

          setExtractMessage(job.message || '');
          setExtractProgress(typeof job.progress === 'number' ? job.progress : 0);

          if (job.status === 'completed') {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setExtracting(false);
            resolve(job.files || []);
            return;
          }

          if (job.status === 'error') {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            setExtracting(false);
            reject(new Error(job.error || 'job failed'));
            return;
          }
        } catch (e: any) {
          console.warn('[ImageUploader] 轮询上传阶段失败:', e);
        }
      }, 600);
    });
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

      const immediateFiles = response.files || [];
      if (immediateFiles.length > 0) {
        immediateFiles.forEach((img) => dispatch(addImage(img)));
      }

      const jobsToPoll: Array<{ jobId: string; kind: 'extract' | 'ingest' }> = [];
      if (response.imageJobs && response.imageJobs.length > 0) {
        for (const j of response.imageJobs) jobsToPoll.push({ jobId: j.jobId, kind: 'ingest' });
      }
      if (response.zipJobs && response.zipJobs.length > 0) {
        for (const j of response.zipJobs) jobsToPoll.push({ jobId: j.jobId, kind: 'extract' });
      }

      if (jobsToPoll.length > 0) {
        void (async () => {
          try {
            const allNewImages: Image[] = [];
            for (const job of jobsToPoll) {
              const newImages = await pollJobToCompletion(job.jobId, job.kind);
              newImages.forEach((img) => dispatch(addImage(img)));
              allNewImages.push(...newImages);
            }

            if (onUploadComplete && allNewImages.length > 0) onUploadComplete(allNewImages);
          } catch (e: any) {
            console.error('[ImageUploader] 后台处理失败:', e);
            alert(`入库/解压失败：${e?.message || '未知错误'}`);
          } finally {
            setExtractProgress(null);
            setExtractMessage('');
            setExtractJobId(null);
            setActiveStageKind('extract');
          }
        })();
      } else {
        // 没有后台 job，则直接回调 immediateFiles
        if (onUploadComplete && immediateFiles.length > 0) onUploadComplete(immediateFiles);
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
        title="图片上传 / 处理进度"
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
              key: 'stage',
              title: activeStageKind === 'ingest' ? '入库进度' : '解压进度',
              percent: extractProgress ?? 0,
              tone: activeStageKind === 'ingest' ? 'primary' : 'extract',
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