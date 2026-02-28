import axios from 'axios';
import type { Image, UploadResponse, AutoAnnotationResponse } from '../types';

// 项目类型定义
interface Project {
  id: number;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface CreateProjectRequest {
  name: string;
  description?: string;
}

const API_BASE_URL = 'http://localhost:3001/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

// 图像相关API
export const imageApi = {
  // 上传图像
  uploadImages: async (files: File[], projectId?: number | string): Promise<UploadResponse> => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });

    if (projectId !== undefined && projectId !== null) {
      formData.append('projectId', String(projectId));
    }
    
    const response = await apiClient.post<UploadResponse>('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  // 获取图像列表
  getImages: async (projectId?: number | string): Promise<Image[]> => {
    const response = await apiClient.get<{ images: Image[] }>('/images', {
      params: projectId ? { projectId } : undefined,
    });
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

// 项目管理API
export const projectApi = {
  // 获取所有项目
  getProjects: async (): Promise<Project[]> => {
    const response = await apiClient.get<Project[]>('/projects');
    return response.data;
  },

  // 创建项目
  createProject: async (projectData: CreateProjectRequest): Promise<Project> => {
    const response = await apiClient.post<Project>('/projects', projectData);
    return response.data;
  },

  // 获取项目详情
  getProject: async (projectId: number): Promise<Project> => {
    const response = await apiClient.get<Project>(`/projects/${projectId}`);
    return response.data;
  },

  // 更新项目
  updateProject: async (projectId: number, projectData: Partial<CreateProjectRequest>): Promise<Project> => {
    const response = await apiClient.put<Project>(`/projects/${projectId}`, projectData);
    return response.data;
  },

  // 删除项目
  deleteProject: async (projectId: number): Promise<void> => {
    await apiClient.delete(`/projects/${projectId}`);
  },
};

// 健康检查
export const healthCheck = async (): Promise<{ status: string; message: string }> => {
  const response = await apiClient.get('/health');
  return response.data;
};

export default apiClient;