import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { setCurrentImage, removeImage } from '../store/annotationSlice';
import type { Image } from '../types';

const ImageList: React.FC = () => {
  const dispatch = useDispatch();
  const { images, currentImage } = useSelector((state: any) => state.annotation);

  const handleImageSelect = (image: Image) => {
    dispatch(setCurrentImage(image));
  };

  const handleImageDelete = (imageId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('确定要删除这张图片吗？')) {
      dispatch(removeImage(imageId));
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
                alt={image.originalName}
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
              <div className="filename" title={image.originalName}>
                {image.originalName}
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