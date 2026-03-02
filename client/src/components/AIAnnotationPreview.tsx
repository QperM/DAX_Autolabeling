import React, { useEffect, useRef, useState } from 'react';
import type { Image, Mask, BoundingBox } from '../types';
import './AIAnnotationPreview.css';

interface AIAnnotationPreviewProps {
  image: Image;
  annotations: {
    masks: Mask[];
    boundingBoxes: BoundingBox[];
  };
  images?: Image[]; // 可切换预览的已标注图片列表
  currentImageId?: number;
  onSelectImage?: (image: Image) => void;
  onClose: () => void;
  onSave: () => void;
  onEdit: () => void;
}

const AIAnnotationPreview: React.FC<AIAnnotationPreviewProps> = ({
  image,
  annotations,
  images = [],
  currentImageId,
  onSelectImage,
  onClose,
  onSave,
  onEdit,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);

  // 生成随机颜色
  const generateColor = (index: number) => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
      '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80'
    ];
    return colors[index % colors.length];
  };

  // 绘制标注
  useEffect(() => {
    if (!canvasRef.current || !imageLoaded) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx || !imageRef.current) return;

    const img = imageRef.current;
    const scaleX = canvas.width / img.width;
    const scaleY = canvas.height / img.height;

    // 清空画布
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制图片
    ctx.drawImage(imageRef.current, 0, 0, canvas.width, canvas.height);

    // 绘制边界框（只画框，不显示文字标签）
    annotations.boundingBoxes.forEach((bbox, index) => {
      const color = generateColor(index);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(
        bbox.x * scaleX,
        bbox.y * scaleY,
        bbox.width * scaleX,
        bbox.height * scaleY
      );

    });

    // 绘制Mask（多边形，只画区域，不显示文字标签）
    annotations.masks.forEach((mask, index) => {
      if (mask.points.length < 6) return; // 至少需要3个点

      const color = generateColor(annotations.boundingBoxes.length + index);
      ctx.fillStyle = color + '80'; // 添加透明度
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      ctx.beginPath();
      for (let i = 0; i < mask.points.length; i += 2) {
        const x = mask.points[i] * scaleX;
        const y = mask.points[i + 1] * scaleY;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

    });
  }, [annotations, imageLoaded]);

  // 加载图片并设置画布尺寸
  useEffect(() => {
    if (!image?.url) {
      console.warn('[AI预览] image.url 为空，无法加载图片', image);
      setImageLoaded(false);
      return;
    }

    console.log('[AI预览] 开始加载图片:', image);
    setImageLoaded(false);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      console.log('[AI预览] 图片加载完成, 原始尺寸:', img.width, img.height);
      imageRef.current = img;
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        // 优先根据容器尺寸来适配画布，让画布“贴合”左侧预览区域
        let maxWidth = 1200;
        let maxHeight = 800;
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          // 略微减去内边距，避免顶到边缘
          maxWidth = rect.width - 32;
          maxHeight = rect.height - 32;
          console.log('[AI预览] 容器尺寸:', rect.width, rect.height, 'maxWidth:', maxWidth, 'maxHeight:', maxHeight);
        }
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = width * ratio;
          height = height * ratio;
        }

        canvas.width = width;
        canvas.height = height;
        console.log('[AI预览] 画布尺寸设置为:', width, height);
        setImageLoaded(true);
      }
    };
    img.onerror = (e) => {
      console.error('[AI预览] 图片加载失败:', e, 'src =', `http://localhost:3001${image.url}`);
      setImageLoaded(false);
    };
    img.src = `http://localhost:3001${image.url}?t=${Date.now()}`;
  }, [image]);

  const totalAnnotations = annotations.masks.length + annotations.boundingBoxes.length;

  return (
    <div className="ai-annotation-preview-overlay">
      <div className="ai-annotation-preview-container">
        <div className="ai-preview-header">
          <div className="ai-preview-title">
            <h2>AI标注结果预览</h2>
            <span className="annotation-count">
              共检测到 {totalAnnotations} 个对象
            </span>
          </div>
          <button className="close-preview-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="ai-preview-content">
          <div className="ai-preview-image-container" ref={containerRef}>
            <canvas ref={canvasRef} className="ai-preview-canvas" />
            {!imageLoaded && (
              <div className="image-loading">加载图片中...</div>
            )}
            <div className="ai-preview-image-info">
              <span className="image-name" title={image.originalName}>
                {image.originalName}
              </span>
              <span className="image-id">ID: {image.id}</span>
            </div>
          </div>

          <div className="ai-preview-sidebar">
            <div className="annotation-stats">
              <h3>标注统计</h3>
              <div className="stat-item">
                <span className="stat-label">边界框:</span>
                <span className="stat-value">{annotations.boundingBoxes.length}</span>
              </div>
              <div className="stat-item">
                <span className="stat-label">分割Mask:</span>
                <span className="stat-value">{annotations.masks.length}</span>
              </div>
            </div>

            {annotations.boundingBoxes.length > 0 && (
              <div className="annotation-list">
                <h3>检测到的对象</h3>
                <div className="annotation-items">
                  {annotations.boundingBoxes.map((bbox, index) => (
                    <div key={bbox.id} className="annotation-item">
                      <div
                        className="color-indicator"
                        style={{ backgroundColor: generateColor(index) }}
                      />
                      {/* 隐藏具体 label 名称，只保留类型信息 */}
                      <span className="item-type">边界框</span>
                    </div>
                  ))}
                  {annotations.masks.map((mask, index) => (
                    <div key={mask.id} className="annotation-item">
                      <div
                        className="color-indicator"
                        style={{ backgroundColor: generateColor(annotations.boundingBoxes.length + index) }}
                      />
                      {/* 隐藏具体 label 名称，只保留类型信息 */}
                      <span className="item-type">Mask</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {images.length > 0 && (
              <div className="annotation-thumbnails">
                <h3>已标注图片</h3>
                <div className="annotation-thumbnails-grid">
                  {images.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      className={`annotation-thumb ${currentImageId === img.id ? 'active' : ''}`}
                      onClick={() => onSelectImage && onSelectImage(img)}
                    >
                      <div className="annotation-thumb-image-wrapper">
                        <img
                          src={`http://localhost:3001${img.url}`}
                          alt={img.originalName}
                          className="annotation-thumb-image"
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="ai-preview-actions">
          <button className="preview-btn secondary" onClick={onClose}>
            取消
          </button>
          <button className="preview-btn secondary" onClick={onEdit}>
            编辑标注
          </button>
          <button className="preview-btn primary" onClick={onSave}>
            保存标注
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIAnnotationPreview;
