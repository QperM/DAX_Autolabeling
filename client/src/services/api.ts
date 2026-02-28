import axios from 'axios';
import type { Image, UploadResponse, AutoAnnotationResponse } from '../types';

const API_BASE_URL = 'http://localhost:3001/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

// 图像相关API
export const imageApi = {
  // 上传图像
  uploadImages: async (files: File[]): Promise<UploadResponse> => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });
    
    const response = await apiClient.post<UploadResponse>('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  // 获取图像列表
  getImages: async (): Promise<Image[]> => {
    const response = await apiClient.get<{ images: Image[] }>('/images');
    return response.data.images;
  },

  // 删除图像
  deleteImage: async (imageId: string): Promise<void> => {
    await apiClient.delete(`/images/${imageId}`);
  },
};

// 标注相关API
export const annotationApi = {
  // 自动标注
  autoAnnotate: async (imageId: string, prompt?: string): Promise<AutoAnnotationResponse> => {
    const response = await apiClient.post<AutoAnnotationResponse>('/annotate/auto', {
      imageId,
      prompt,
    });
    return response.data;
  },

  // 保存标注
  saveAnnotation: async (imageId: string, annotationData: any): Promise<any> => {
    const response = await apiClient.post(`/annotations/${imageId}`, annotationData);
    return response.data;
  },

  // 获取标注
  getAnnotation: async (imageId: string): Promise<any> => {
    const response = await apiClient.get(`/annotations/${imageId}`);
    return response.data;
  },
};

// 健康检查
export const healthCheck = async (): Promise<{ status: string; message: string }> => {
  const response = await apiClient.get('/health');
  return response.data;
};

export default apiClient;