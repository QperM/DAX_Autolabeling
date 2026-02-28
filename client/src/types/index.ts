// 图像类型定义
export interface Image {
  id: string;
  filename: string;
  url: string;
  originalName: string;
  size?: number;
  width?: number;
  height?: number;
  uploadTime: string;
}

// Mask类型定义
export interface Mask {
  id: string;
  points: number[]; // [x1, y1, x2, y2, ...]
  label: string;
  color?: string;
  opacity?: number;
}

// 边界框类型定义
export interface BoundingBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color?: string;
}

// 多边形类型定义
export interface Polygon {
  id: string;
  points: number[]; // [x1, y1, x2, y2, ...]
  label: string;
  color?: string;
  editable?: boolean;
}

// 标注数据类型
export interface Annotation {
  imageId: string;
  masks: Mask[];
  boundingBoxes: BoundingBox[];
  polygons: Polygon[];
  createdAt: string;
  updatedAt: string;
}

// 工具模式类型
export type ToolMode = 'select' | 'eraser' | 'polygon' | 'bbox';

// 应用状态类型
export interface AppState {
  currentImage: Image | null;
  images: Image[];
  annotations: Record<string, Annotation>;
  toolMode: ToolMode;
  brushSize: number;
  selectedAnnotationId: string | null;
  history: Annotation[];
  historyIndex: number;
  loading: boolean;
  error: string | null;
}

// API响应类型
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// 文件上传响应
export interface UploadResponse {
  files: Image[];
  message: string;
}

// 自动标注响应
export interface AutoAnnotationResponse {
  annotations: {
    masks: Mask[];
    boundingBoxes: BoundingBox[];
  };
  message: string;
}