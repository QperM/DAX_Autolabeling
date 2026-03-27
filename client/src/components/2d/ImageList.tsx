import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { setCurrentImage, removeImage, setLoading, setError } from '../../store/annotationSlice';
import { imageApi } from '../../services/api';
import type { Image } from '../../types';
import { useAppAlert } from '../common/AppAlert';

const ImageList: React.FC = () => {
  const dispatch = useDispatch();
  const { images, currentImage } = useSelector((state: any) => state.annotation);
  const { alert, confirm } = useAppAlert();

  const handleImageSelect = (image: Image) => {
    dispatch(setCurrentImage(image));
  };

  const handleImageDelete = async (imageId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (await confirm('确定要删除这张图片吗？', { title: '确认删除' })) {
      console.log(`[ImageList] 开始删除图片，ID: ${imageId}`);
      
      try {
        dispatch(setLoading(true));
        
        // 调用后端API删除图片
        console.log(`[ImageList] 调用API删除图片: DELETE /api/images/${imageId}`);
        await imageApi.deleteImage(imageId);
        console.log(`[ImageList] API调用成功，图片ID ${imageId} 已从数据库删除`);
        
        // 从Redux状态中移除图片
        dispatch(removeImage(imageId));
        console.log(`[ImageList] 已从Redux状态中移除图片ID: ${imageId}`);
        
        console.log(`[ImageList] 删除图片流程完成，图片ID: ${imageId}`);
      } catch (error: any) {
        console.error(`[ImageList] 删除图片失败，图片ID: ${imageId}:`, error);
        dispatch(setError(error.message || '删除图片失败'));
        alert(`删除图片失败: ${error.message || '未知错误'}`);
      } finally {
        dispatch(setLoading(false));
      }
    }
  };

  if (images.length === 0) {
    return (
      <div className="image-list empty">
        <p>暂无图片</p>
        <p className="hint">请先上传图片开始标注</p>
      </div>
    );
  }

  return (
    <div className="image-list">
      <div className="image-list-header">
        <h3>图片列表 ({images.length})</h3>
      </div>
      <div className="image-thumbnails">
        {images.map((image: Image) => (
          <div
            key={image.id}
            className={`thumbnail-item ${currentImage?.id === image.id ? 'selected' : ''}`}
            onClick={() => handleImageSelect(image)}
          >
            <div className="thumbnail-wrapper">
              <img 
                src={image.url} 
                alt={image.originalName || image.filename}
                className="thumbnail-image"
              />
              <button
                className="delete-button"
                onClick={(e) => handleImageDelete(image.id, e)}
                title="删除图片"
              >
                ×
              </button>
            </div>
            <div className="thumbnail-info">
              <div className="filename" title={`${image.originalName || image.filename}\n存储: ${image.filename}`}>
                {image.originalName || image.filename}
              </div>
              <div className="upload-time">
                {new Date(image.uploadTime).toLocaleString()}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ImageList;