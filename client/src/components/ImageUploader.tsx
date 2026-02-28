import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { useDispatch } from 'react-redux';
import { imageApi } from '../services/api';
import { addImage, setLoading, setError } from '../store/annotationSlice';
import type { Image } from '../types';

interface ImageUploaderProps {
  onUploadComplete?: (images: Image[]) => void;
}

const ImageUploader: React.FC<ImageUploaderProps> = ({ onUploadComplete }) => {
  const dispatch = useDispatch();

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    try {
      console.log('📁 接收到文件:', acceptedFiles.map(f => f.name));
      dispatch(setLoading(true));
      dispatch(setError(null));
      
      // 上传文件到服务器
      console.log('📤 开始上传文件...');
      const response = await imageApi.uploadImages(acceptedFiles);
      console.log('📥 上传响应:', response);
      
      // 将上传的图像添加到状态中
      response.files.forEach(image => {
        console.log('➕ 添加图片到状态:', image);
        dispatch(addImage(image));
      });
      
      if (onUploadComplete) {
        onUploadComplete(response.files);
      }
      
      console.log(`${response.files.length}个文件上传成功`);
    } catch (error: any) {
      console.error('❌ 上传失败:', error);
      dispatch(setError(error.message || '文件上传失败'));
    } finally {
      dispatch(setLoading(false));
    }
  }, [dispatch, onUploadComplete]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.gif', '.bmp', '.tiff', '.webp'],
      'application/zip': ['.zip'],
      'application/x-zip-compressed': ['.zip']
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
    </div>
  );
};

export default ImageUploader;