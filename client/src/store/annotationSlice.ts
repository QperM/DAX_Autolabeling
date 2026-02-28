import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Image, Annotation, ToolMode, AppState } from '../types';

const initialState: AppState = {
  currentImage: null,
  images: [],
  annotations: {},
  toolMode: 'select',
  brushSize: 10,
  selectedAnnotationId: null,
  history: [],
  historyIndex: -1,
  loading: false,
  error: null,
};

export const annotationSlice = createSlice({
  name: 'annotation',
  initialState,
  reducers: {
    setCurrentImage: (state, action: PayloadAction<Image | null>) => {
      state.currentImage = action.payload;
    },
    
    setImages: (state, action: PayloadAction<Image[]>) => {
      state.images = action.payload;
    },
    
    addImage: (state, action: PayloadAction<Image>) => {
      state.images.push(action.payload);
    },
    
    removeImage: (state, action: PayloadAction<string>) => {
      state.images = state.images.filter(img => img.id !== action.payload);
      if (state.currentImage?.id === action.payload) {
        state.currentImage = null;
      }
      delete state.annotations[action.payload];
    },
    
    setToolMode: (state, action: PayloadAction<ToolMode>) => {
      state.toolMode = action.payload;
    },
    
    setBrushSize: (state, action: PayloadAction<number>) => {
      state.brushSize = action.payload;
    },
    
    setAnnotation: (state, action: PayloadAction<{ imageId: string; annotation: Annotation }>) => {
      const { imageId, annotation } = action.payload;
      state.annotations[imageId] = annotation;
      
      // 添加到历史记录
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push(JSON.parse(JSON.stringify(annotation)));
      state.historyIndex = state.history.length - 1;
    },
    
    updateAnnotation: (state, action: PayloadAction<{ imageId: string; annotation: Partial<Annotation> }>) => {
      const { imageId, annotation } = action.payload;
      if (state.annotations[imageId]) {
        state.annotations[imageId] = {
          ...state.annotations[imageId],
          ...annotation,
          updatedAt: new Date().toISOString()
        };
      }
    },
    
    setSelectedAnnotationId: (state, action: PayloadAction<string | null>) => {
      state.selectedAnnotationId = action.payload;
    },
    
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    
    undo: (state) => {
      if (state.historyIndex > 0 && state.currentImage) {
        state.historyIndex--;
        const previousAnnotation = state.history[state.historyIndex];
        state.annotations[state.currentImage.id] = JSON.parse(JSON.stringify(previousAnnotation));
      }
    },
    
    redo: (state) => {
      if (state.historyIndex < state.history.length - 1 && state.currentImage) {
        state.historyIndex++;
        const nextAnnotation = state.history[state.historyIndex];
        state.annotations[state.currentImage.id] = JSON.parse(JSON.stringify(nextAnnotation));
      }
    },
    
    clearHistory: (state) => {
      state.history = [];
      state.historyIndex = -1;
    },
  },
});

export const {
  setCurrentImage,
  setImages,
  addImage,
  removeImage,
  setToolMode,
  setBrushSize,
  setAnnotation,
  updateAnnotation,
  setSelectedAnnotationId,
  setLoading,
  setError,
  undo,
  redo,
  clearHistory,
} = annotationSlice.actions;

export default annotationSlice.reducer;