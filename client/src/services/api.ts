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

export interface ProjectAnnotationSummary {
  totalImages: number;
  annotatedImages: number;
  latestAnnotatedImageId: number | null;
  latestUpdatedAt: string | null;
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
  uploadImages: async (
    files: File[],
    projectId?: number | string,
    onUploadProgress?: (progressPercent: number) => void
  ): Promise<UploadResponse> => {
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
      onUploadProgress: (evt) => {
        if (!onUploadProgress) return;
        const total = evt.total || 0;
        if (!total) return;
        const pct = Math.round((evt.loaded / total) * 100);
        onUploadProgress(Math.max(0, Math.min(100, pct)));
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
  deleteImage: async (imageId: number): Promise<void> => {
    await apiClient.delete(`/images/${imageId}`);
  },

  // （可选扩展）按ID获取单张图像（目前前端未使用，如需可启用）
  // getImage: async (imageId: number): Promise<Image> => {
  //   const response = await apiClient.get<Image>(`/images/${imageId}`);
  //   return response.data;
  // },
};

// 上传 job 进度（ZIP 解压等）
export const uploadJobApi = {
  getJob: async (jobId: string): Promise<any> => {
    const response = await apiClient.get(`/upload-jobs/${jobId}`);
    return response.data;
  },
};

// 标注相关API
export const annotationApi = {
  // 自动标注
  autoAnnotate: async (
    imageId: number,
    prompt?: string,
    modelParams?: {
      baseScoreThresh?: number;
      lowerScoreThresh?: number;
      maxDetections?: number;
    }
  ): Promise<AutoAnnotationResponse> => {
    const response = await apiClient.post<AutoAnnotationResponse>('/annotate/auto', {
      imageId,
      prompt,
      modelParams,
    });
    return response.data;
  },

  // 保存标注
  saveAnnotation: async (imageId: number, annotationData: any): Promise<any> => {
    const response = await apiClient.post(`/annotations/${imageId}`, annotationData);
    return response.data;
  },

  // 获取标注
  getAnnotation: async (imageId: number): Promise<any> => {
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

  // 获取项目标注汇总
  getAnnotationSummary: async (projectId: number): Promise<ProjectAnnotationSummary> => {
    const response = await apiClient.get<{ success: boolean; summary: ProjectAnnotationSummary }>(
      `/projects/${projectId}/annotation-summary`
    );
    return response.data.summary;
  },
};

// 健康检查
export const healthCheck = async (): Promise<{ status: string; message: string }> => {
  const response = await apiClient.get('/health');
  return response.data;
};

export default apiClient;