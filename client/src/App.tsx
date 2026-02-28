import React, { useEffect, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { store } from './store';
import LandingPage from './components/LandingPage';
import ImageUploader from './components/ImageUploader';
import AnnotationCanvas from './components/AnnotationCanvas';
import Toolbar from './components/Toolbar';
import ImageList from './components/ImageList';
import { imageApi } from './services/api';
import { setImages, setLoading, setError, setAnnotation, setCurrentImage } from './store/annotationSlice';
import type { Image, Annotation } from './types';
import './App.css';

const AnnotationPage: React.FC = () => {
  const dispatch = useDispatch();
  const { currentImage, images, annotations, toolMode, brushSize, loading, error } = useSelector((state: any) => state.annotation);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState<Image | null>(null);


  // 检查是否选择了模块
  useEffect(() => {
    const selectedModules = localStorage.getItem('selectedModules');
    if (!selectedModules) {
      window.location.href = '/';
    }
  }, []);

  // 加载已有图像
  useEffect(() => {
    const loadImages = async () => {
      try {
        dispatch(setLoading(true));
        const loadedImages = await imageApi.getImages();
        dispatch(setImages(loadedImages));
      } catch (err: any) {
        dispatch(setError(err.message || '加载图像失败'));
      } finally {
        dispatch(setLoading(false));
      }
    };

    loadImages();
  }, [dispatch]);

  const handleUploadComplete = (newImages: Image[]) => {
    console.log('上传完成:', newImages);
  };

  const handleMaskUpdate = (updatedMasks: any[]) => {
    if (currentImage) {
      const currentAnnotation: Annotation = annotations[currentImage.id] || {
        imageId: currentImage.id,
        masks: [],
        boundingBoxes: [],
        polygons: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      const updatedAnnotation = {
        ...currentAnnotation,
        masks: updatedMasks,
        updatedAt: new Date().toISOString()
      };
      
      dispatch(setAnnotation({ 
        imageId: currentImage.id, 
        annotation: updatedAnnotation 
      }));
    }
  };

  const handlePolygonUpdate = (updatedPolygons: any[]) => {
    if (currentImage) {
      const currentAnnotation: Annotation = annotations[currentImage.id] || {
        imageId: currentImage.id,
        masks: [],
        boundingBoxes: [],
        polygons: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      const updatedAnnotation = {
        ...currentAnnotation,
        polygons: updatedPolygons,
        updatedAt: new Date().toISOString()
      };
      
      dispatch(setAnnotation({ 
        imageId: currentImage.id, 
        annotation: updatedAnnotation 
      }));
    }
  };

  const currentAnnotation = currentImage ? annotations[currentImage.id] : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>智能图像标注系统</h1>
        <div className="header-actions">
          <span className="status">
            {loading ? '加载中...' : `${images.length} 张图片`}
          </span>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          错误: {error}
          <button onClick={() => dispatch(setError(null))}>×</button>
        </div>
      )}

      <div className="main-content">
        {!currentImage ? (
          <div className="welcome-section">
            {/* 三区域布局 */}
            <div className="welcome-layout">
              {/* 左上区域 - 欢迎内容 */}
              <div className="welcome-left-top">
                <div className="welcome-content">
                  <h2>欢迎使用智能图像标注系统</h2>
                  <p>请上传图片开始您的标注工作</p>
                  <ImageUploader onUploadComplete={handleUploadComplete} />
                </div>
              </div>
              
              {/* 右上区域 - 图片预览放大 */}
              <div className="welcome-right-top">
                {selectedPreviewImage ? (
                  <div className="image-preview-container">
                    <div className="preview-header">
                      <h3>{selectedPreviewImage.originalName}</h3>
                      <button 
                        className="close-preview-btn"
                        onClick={() => setSelectedPreviewImage(null)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="image-preview-wrapper">
                      <img 
                        src={`http://localhost:3001${selectedPreviewImage.url}?t=${Date.now()}`} 
                        alt={selectedPreviewImage.originalName}
                        className="preview-image"
                      />
                    </div>
                    <div className="preview-actions">
                      <button 
                        className="start-annotation-btn"
                        onClick={() => {
                          dispatch(setCurrentImage(selectedPreviewImage));
                          setSelectedPreviewImage(null);
                        }}
                      >
                        开始标注此图片
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="no-preview-selected">
                    <div className="preview-placeholder">
                      <span className="preview-icon">🔍</span>
                      <p>点击下方缩略图查看详情</p>
                    </div>
                  </div>
                )}
              </div>
              
              {/* 下方区域 - 缩略图网格 */}
              {images.length > 0 && (
                <div className="welcome-bottom">
                  <div className="uploaded-images-preview">
                    <div className="preview-header">
                      <h3>已上传图片 ({images.length})</h3>
                      <div>
                        <button 
                          className="start-annotation-btn"
                          onClick={() => dispatch(setCurrentImage(images[0]))}
                        >
                          开始标注 →
                        </button>
                      </div>
                    </div>
                    <div className="thumbnails-grid">
                      {images.slice(0, 12).map((image: Image) => (
                        <div 
                          key={image.id}
                          className="thumbnail-item-small"
                          onClick={() => setSelectedPreviewImage(image)}
                        >
                          <img 
                            src={`http://localhost:3001${image.url}?t=${Date.now()}`} 
                            alt={image.originalName}
                            onError={() => {
                              console.error('❌ 图片加载失败:', image.url);
                            }}
                            onLoad={() => {
                              console.log('✅ 图片加载成功:', image.url);
                            }}
                          />
                          <div className="thumbnail-overlay">
                            <span className="thumbnail-name">{image.originalName}</span>
                          </div>
                        </div>
                      ))}
                      {images.length > 12 && (
                        <div className="thumbnail-item-small more-indicator">
                          <div className="more-count">+{images.length - 12}</div>
                          <div className="more-text">更多图片</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="workspace">
              <div className="left-panel">
                <Toolbar />
              </div>
              
              <div className="center-panel">
                <div className="canvas-container">
                  <AnnotationCanvas
                    imageUrl={currentImage.url}
                    masks={currentAnnotation?.masks || []}
                    boundingBoxes={currentAnnotation?.boundingBoxes || []}
                    polygons={currentAnnotation?.polygons || []}
                    toolMode={toolMode}
                    brushSize={brushSize}
                    onMaskUpdate={handleMaskUpdate}
                    onPolygonUpdate={handlePolygonUpdate}
                  />
                </div>
              </div>
              
              <div className="right-panel">
                <ImageList />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const AppContent: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/annotate" element={<AnnotationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
};

function App() {
  return (
    <Provider store={store}>
      <AppContent />
    </Provider>
  );
}

export default App;