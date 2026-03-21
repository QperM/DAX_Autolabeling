import axios from 'axios';
import type { Image, UploadResponse, AutoAnnotationResponse } from '../types';

// 项目类型定义
export interface Project {
  id: number;
  name: string;
  description: string;
  access_code?: string | null;
  locked?: boolean;
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

// API 基础地址：
// - 开发模式（Vite dev server，端口 5173）：直接打到 http://localhost:3001/api，保持原来的跨域 + Cookie 方案，避免代理导致的 Cookie 丢失
// - 生产/打包（Docker + Nginx）：使用相对路径 /api，由 Nginx 反向代理到 dax-api:3001
const API_BASE_URL =
  import.meta.env.MODE === 'development'
    ? 'http://localhost:3001/api'
    : '/api';

// uploads 静态资源地址（OBJ/MTL/贴图等）
// 开发模式下必须指向 3001，否则 /uploads/... 会落到 Vite(5173) 导致 404 且后端无日志
const UPLOADS_BASE_URL =
  import.meta.env.MODE === 'development'
    ? 'http://localhost:3001'
    : '';

function toAbsoluteUploadsUrl(u?: string | null): string | undefined {
  if (!u) return undefined;
  if (/^(blob:|data:|https?:\/\/)/i.test(u)) return u;
  if (u.startsWith('/uploads/')) return `${UPLOADS_BASE_URL}${u}`;
  return u;
}

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  withCredentials: true, // 发送 session cookie，确保登录状态保持
});

// 图像相关API
export const imageApi = {
  // 上传图像
  uploadImages: async (
    files: File[],
    projectId?: number | string,
    onUploadProgress?: (progressPercent: number) => void
  ): Promise<UploadResponse> => {
    // 为大体积上传单独实现“无进度超时”逻辑：
    // - 禁用 axios 自带的 30s 硬超时
    // - 仅在一段时间内完全没有收到上传进度事件时才中断
    const INACTIVITY_TIMEOUT_MS = 30000; // 无进度累计 30s 才视为超时
    const controller = new AbortController();
    let lastProgressTs = Date.now();

    const inactivityTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressTs > INACTIVITY_TIMEOUT_MS) {
        controller.abort();
        clearInterval(inactivityTimer);
      }
    }, 1000);

    const formData = new FormData();
    files.forEach(file => {
      formData.append('images', file);
    });

    if (projectId !== undefined && projectId !== null) {
      formData.append('projectId', String(projectId));
    }

    try {
      const response = await apiClient.post<UploadResponse>('/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        // 禁用该请求自身的 axios 超时，由上面的“无进度超时”来控制
        timeout: 0,
        signal: controller.signal,
        onUploadProgress: (evt) => {
          // 一旦有进度，就刷新“最后进度时间”，防止误判超时
          lastProgressTs = Date.now();

          if (!onUploadProgress) return;
          const total = evt.total || 0;
          if (!total) return;
          const pct = Math.round((evt.loaded / total) * 100);
          onUploadProgress(Math.max(0, Math.min(100, pct)));
        },
      });
      return response.data;
    } finally {
      clearInterval(inactivityTimer);
    }
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

// 9D Pose Mesh (OBJ) upload API
export const meshApi = {
  uploadMeshes: async (
    files: File[],
    projectId: number | string,
    onUploadProgress?: (progressPercent: number) => void
  ): Promise<{
    success: boolean;
    files: Array<{
      id?: number;
      filename: string;
      originalName: string;
      size?: number;
      url: string;
      assetDirUrl?: string;
      assets?: string[];
      skuLabel?: string | null;
      bbox?: any;
    }>;
  }> => {
    // 与图片上传一致：改为基于“无进度时间”的超时控制
    const INACTIVITY_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    let lastProgressTs = Date.now();

    const inactivityTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressTs > INACTIVITY_TIMEOUT_MS) {
        controller.abort();
        clearInterval(inactivityTimer);
      }
    }, 1000);

    const formData = new FormData();
    files.forEach((file) => {
      formData.append('meshes', file);
    });
    formData.append('projectId', String(projectId));

    try {
      const response = await apiClient.post('/meshes/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 0,
        signal: controller.signal,
        onUploadProgress: (evt) => {
          lastProgressTs = Date.now();
          if (!onUploadProgress) return;
          const total = evt.total || 0;
          if (!total) return;
          const pct = Math.round((evt.loaded / total) * 100);
          onUploadProgress(Math.max(0, Math.min(100, pct)));
        },
      });
      const data = response.data as any;
      const filesOut = Array.isArray(data?.files) ? data.files : [];
      return {
        ...data,
        files: filesOut.map((m: any) => ({
          ...m,
          url: toAbsoluteUploadsUrl(m?.url) || m?.url,
          assetDirUrl: toAbsoluteUploadsUrl(m?.assetDirUrl),
        })),
      };
    } finally {
      clearInterval(inactivityTimer);
    }
  },
  getMeshes: async (
    projectId: number | string
  ): Promise<Array<{ id: number; filename: string; originalName: string; size?: number; url: string; uploadTime?: string; assetDirUrl?: string; assets?: string[]; skuLabel?: string | null }>> => {
    const response = await apiClient.get<{ success: boolean; meshes: any[] }>('/meshes', {
      params: { projectId },
    });
    const meshes = response.data.meshes || [];
    return meshes.map((m: any) => ({
      ...m,
      url: toAbsoluteUploadsUrl(m?.url) || m?.url,
      assetDirUrl: toAbsoluteUploadsUrl(m?.assetDirUrl),
    }));
  },
  deleteMesh: async (meshId: number | string): Promise<{ success: boolean; changes?: number; message?: string }> => {
    const response = await apiClient.delete(`/meshes/${meshId}`);
    return response.data;
  },
  updateMesh: async (
    meshId: number | string,
    payload: { skuLabel?: string | null },
  ): Promise<{ success: boolean; changes?: number; message?: string }> => {
    const response = await apiClient.put(`/meshes/${meshId}`, payload);
    return response.data;
  },
};

// 深度图 / 深度原始数据 API
export const depthApi = {
  uploadDepth: async (
    files: File[],
    projectId: number | string,
    onUploadProgress?: (progressPercent: number) => void
  ): Promise<{
    success: boolean;
    files: Array<{
      id?: number | null;
      filename: string;
      originalName: string;
      size?: number;
      url: string;
      role?: string;
      modality?: string;
      imageId?: number | null;
      cameraId?: number | null;
    }>;
  }> => {
    // 深度图上传同样采用“无进度超时”策略
    const INACTIVITY_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    let lastProgressTs = Date.now();

    const inactivityTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressTs > INACTIVITY_TIMEOUT_MS) {
        controller.abort();
        clearInterval(inactivityTimer);
      }
    }, 1000);

    const formData = new FormData();
    files.forEach((file) => {
      formData.append('depthFiles', file);
    });
    formData.append('projectId', String(projectId));

    try {
      const response = await apiClient.post('/depth/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 0,
        signal: controller.signal,
        onUploadProgress: (evt) => {
          lastProgressTs = Date.now();
          if (!onUploadProgress) return;
          const total = evt.total || 0;
          if (!total) return;
          const pct = Math.round((evt.loaded / total) * 100);
          onUploadProgress(Math.max(0, Math.min(100, pct)));
        },
      });
      return response.data;
    } finally {
      clearInterval(inactivityTimer);
    }
  },

  getDepth: async (
    projectId: number | string,
    imageId?: number | string
  ): Promise<Array<{ id: number; filename: string; originalName: string; size?: number; url: string; role?: string; modality?: string; uploadTime?: string; imageId?: number }>> => {
    const params: any = { projectId };
    if (imageId != null) params.imageId = imageId;
    const response = await apiClient.get<{ success: boolean; depth: any[] }>('/depth', { params });
    return response.data.depth || [];
  },
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
    modelParams?: {
      maxPolygonPoints?: number;
      sam2PointsPerSide?: number;
      sam2PredIouThresh?: number;
      sam2StabilityScoreThresh?: number;
      sam2BoxNmsThresh?: number;
      sam2MinMaskRegionArea?: number;
    }
  ): Promise<AutoAnnotationResponse> => {
    const response = await apiClient.post<AutoAnnotationResponse>('/annotate/auto', {
      imageId,
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

// 9D Pose API
export const pose9dApi = {
  savePose9D: async (imageId: number | string, payload: any): Promise<any> => {
    const response = await apiClient.post(`/pose9d/${imageId}`, payload);
    return response.data;
  },
  saveInitialPose: async (imageId: number | string, payload: any): Promise<any> => {
    const response = await apiClient.post(`/pose9d/${imageId}/initial-pose`, payload);
    return response.data;
  },
  getPose9D: async (imageId: number | string, meshId?: number | string | null): Promise<any> => {
    const response = await apiClient.get(`/pose9d/${imageId}`, { params: meshId != null ? { meshId } : undefined });
    return response.data;
  },
  listPose9D: async (imageId: number | string): Promise<any> => {
    const response = await apiClient.get(`/pose9d/${imageId}/all`);
    return response.data;
  },
  deletePose9D: async (imageId: number | string, meshId?: number | string | null): Promise<any> => {
    const response = await apiClient.delete(`/pose9d/${imageId}`, { params: meshId != null ? { meshId } : undefined });
    return response.data;
  },
  saveDiffdopePose44: async (
    imageId: number | string,
    meshId: number | string,
    pose44: number[][],
  ): Promise<any> => {
    const response = await apiClient.post(`/pose9d/${imageId}/${meshId}/diffdope-pose44`, { pose44 });
    return response.data;
  },
};

// 6D Pose (Diff-DOPE) API
export const pose6dApi = {
  diffdopeEstimate: async (
    imageId: number | string,
    payload?: {
      projectId?: number | string | null;
      onlyUniqueMasks?: boolean;
      stage1Iters?: number;
      stage2Iters?: number;
      iters?: number;
      batchSize?: number;
      lrLow?: number;
      lrHigh?: number;
      baseLr?: number;
      lrDecay?: number;
      useMaskLoss?: boolean;
      useRgbLoss?: boolean;
      useDepthLoss?: boolean;
      weightMask?: number;
      weightRgb?: number;
      weightDepth?: number;
      stage1WeightMask?: number;
      stage2WeightMask?: number;
      stage2WeightDepth?: number;
      stage1EarlyStopLoss?: number | null;
      stage2EarlyStopLoss?: number | null;
      stage2BaseLr?: number;
      stage2LrDecay?: number;
      maxAllowedFinalLoss?: number | null;
      returnDebugImages?: boolean;
      /** 打开端到端调试日志（前端/Node/pose-service 都会输出更多信息） */
      debug?: boolean;
    },
  ): Promise<any> => {
    const response = await apiClient.post(`/pose6d/${imageId}/diffdope-estimate`, payload || {}, { timeout: 5 * 60 * 1000 });
    return response.data;
  },
};

// 9D Pose: Fit rotation (server-side)
export const poseFitApi = {
  fitRotation: async (
    imageId: number | string,
    payload: {
      meshId: number | string;
      maskIndex?: number;
      maskId?: string;
      mode?: 'z' | 'xyz';
      rasterSize?: number;
      projectionDetail?: 'fast' | 'balanced' | 'high';
      debug?: boolean;
      initialRotationDeg?: { x?: number; y?: number; z?: number };
      search?: {
        zMin?: number;
        zMax?: number;
        zStep?: number;
        xMin?: number;
        xMax?: number;
        xStep?: number;
        yMin?: number;
        yMax?: number;
        yStep?: number;
      };
    }
  ): Promise<{
    success: boolean;
    bestIoU?: number;
    bestRotationDeg?: { x: number; y: number; z: number };
    meshHullSvgPoints?: string;
    meshHull?: Array<[number, number]>;
    diagnostics?: any;
    message?: string;
    error?: string;
  }> => {
    // pose fitting can be CPU-heavy on server (xyz search + raster IoU), so allow longer timeout
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const response = await apiClient.post(`/pose9d/${imageId}/fit-rotation`, payload, { timeout: 120000 });
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // Profiling is enabled by default during performance investigation.
    // eslint-disable-next-line no-console
    console.log('[poseFitApi.fitRotation] payload:', payload);
    // eslint-disable-next-line no-console
    console.log(`[poseFitApi.fitRotation] httpMs=${(t1 as number) - (t0 as number)}`, response.data);
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
    // 项目删除可能涉及大量文件（depth/mesh/images）清理，默认 30s timeout 容易误报超时
    await apiClient.delete(`/projects/${projectId}`, { timeout: 5 * 60 * 1000 });
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

// 认证相关API
export const authApi = {
  // 验证码验证
  verifyCode: async (accessCode: string): Promise<{ success: boolean; project: Project }> => {
    const response = await apiClient.post<{ success: boolean; project: Project }>('/auth/verify-code', {
      accessCode
    });
    return response.data;
  },
  
  // 管理员登录
  login: async (username: string, password: string): Promise<{ success: boolean; user: { id: number; username: string; role: string } }> => {
    const response = await apiClient.post<{ success: boolean; user: { id: number; username: string; role: string } }>('/auth/login', {
      username,
      password
    });
    return response.data;
  },
  
  // 登出
  logout: async (): Promise<{ success: boolean }> => {
    const response = await apiClient.post<{ success: boolean }>('/auth/logout');
    return response.data;
  },
  
  // 检查登录状态
  checkAuth: async (): Promise<{ authenticated: boolean; isAdmin?: boolean; user?: { id: number; username: string } }> => {
    const response = await apiClient.get<{ authenticated: boolean; isAdmin?: boolean; user?: { id: number; username: string } }>('/auth/check');
    return response.data;
  },
  
  // 获取可访问的项目列表
  getAccessibleProjects: async (): Promise<Project[]> => {
    const response = await apiClient.get<Project[]>('/auth/accessible-projects');
    return response.data;
  },

  // 管理员修改密码（需要已登录）
  changePassword: async (currentPassword: string, newPassword: string, confirmPassword: string): Promise<{ success: boolean }> => {
    const response = await apiClient.post<{ success: boolean }>('/auth/change-password', {
      currentPassword,
      newPassword,
      confirmPassword,
    });
    return response.data;
  },
};

// 管理员API
export const adminApi = {
  // 获取所有项目（管理员）
  getAllProjects: async (): Promise<Project[]> => {
    const response = await apiClient.get<Project[]>('/admin/projects');
    return response.data;
  },
  
  // 创建项目（管理员，自动生成验证码）
  createProject: async (projectData: CreateProjectRequest): Promise<Project> => {
    const response = await apiClient.post<Project>('/admin/projects', projectData);
    return response.data;
  },
  
  // 重新生成项目验证码
  regenerateAccessCode: async (projectId: number): Promise<Project> => {
    const response = await apiClient.post<Project>(`/admin/projects/${projectId}/regenerate-code`);
    return response.data;
  },
  
  // 锁定/解锁项目
  toggleProjectLock: async (projectId: number): Promise<Project> => {
    const response = await apiClient.post<Project>(`/admin/projects/${projectId}/toggle-lock`);
    return response.data;
  }
};

export default apiClient;