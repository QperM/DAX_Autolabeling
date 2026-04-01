import axios from 'axios';
import type { Image, UploadResponse, AutoAnnotationResponse } from '../types';
import type { DebugSettingsPayload } from '../utils/debugSettings';

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

export interface ProjectLabelColorMapping {
  projectId: number;
  label: string;
  labelZh?: string;
  labelKey: string;
  color: string;
  usageOrder: number;
  createdAt?: string | null;
  updatedAt?: string | null;
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
    // 之前这里是 30s，但大批量上传时：包体上传完后服务器可能还要较久写库/落文件，
    // 这段时间不会再产生 onUploadProgress 事件，容易被误判为“无进度超时”并 abort。
    // 因此把阈值放大到 10 分钟，并且在 loaded >= total 时立即停止该保护。
    const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 无进度累计 10min 才视为超时
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
          const loaded = evt.loaded || 0;

          // 如果 axios 给出了 total，则用 loaded >= total 判断“包体发送完成”，
          // 这比仅依赖四舍五入后的百分比更可靠。
          const bodyLikelyComplete = total > 0 && loaded >= total;
          if (bodyLikelyComplete) {
            clearInterval(inactivityTimer);
          }

          if (!total) return;

          const pct = Math.round((loaded / total) * 100);
          const clamped = Math.max(0, Math.min(100, pct));
          onUploadProgress(clamped);

          // 兜底：如果 UI 侧已经显示 100%，也停止无进度保护
          if (clamped >= 100) clearInterval(inactivityTimer);
        },
      });
      return response.data;
    } finally {
      clearInterval(inactivityTimer);
    }
  },

  // 获取图像列表（支持分页，避免一次性拉爆）
  getImages: async (
    projectId?: number | string,
    options?: { offset?: number; limit?: number },
  ): Promise<Image[]> => {
    const params: any = {};
    if (projectId) params.projectId = projectId;
    if (options?.offset != null) params.offset = options.offset;
    if (options?.limit != null) params.limit = options.limit;

    const response = await apiClient.get<{ images: Image[] }>('/images', {
      params: Object.keys(params).length ? params : undefined,
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
    } catch (error: any) {
      const serverMsg =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        'Depth 上传失败';
      throw new Error(String(serverMsg));
    } finally {
      clearInterval(inactivityTimer);
    }
  },

  getDepth: async (
    projectId: number | string,
    imageId?: number | string
  ): Promise<
    Array<{
      id: number | null;
      filename: string;
      originalName?: string | null;
      size?: number;
      url: string;
      role?: string;
      modality?: string;
      uploadTime?: string;
      imageId?: number | null;
      cameraId?: number | null;
      depthRawFixUrl?: string | null;
      depthPngFixUrl?: string | null;
    }>
  > => {
    const params: any = { projectId };
    if (imageId != null) params.imageId = imageId;
    const response = await apiClient.get<{ success: boolean; depth: any[] }>('/depth', { params });
    return response.data.depth || [];
  },

  getCameras: async (
    projectId: number | string
  ): Promise<
    Array<{
      id: number;
      projectId: number;
      role: string;
      intrinsics: any;
      intrinsicsFileSize?: number | null;
      intrinsicsOriginalName?: string | null;
      updatedAt?: string | null;
    }>
  > => {
    const response = await apiClient.get<{ success: boolean; cameras: any[] }>('/depth/cameras', {
      params: { projectId },
    });
    return Array.isArray(response.data?.cameras) ? response.data.cameras : [];
  },

  deleteDepthMap: async (depthId: number | string): Promise<{ success: boolean; deleted?: boolean; message?: string }> => {
    const response = await apiClient.delete(`/depth/maps/${depthId}`);
    return response.data;
  },

  deleteDepthFile: async (
    depthId: number | string,
    kind: 'depth_png' | 'depth_raw' | 'depth_png_fix' | 'depth_raw_fix',
  ): Promise<{ success: boolean; deleted?: boolean; message?: string }> => {
    const response = await apiClient.delete(`/depth/maps/${depthId}/file`, {
      params: { kind },
    });
    return response.data;
  },

  deleteCamera: async (cameraId: number | string): Promise<{ success: boolean; deleted?: boolean; message?: string }> => {
    const response = await apiClient.delete(`/depth/cameras/${cameraId}`);
    return response.data;
  },

  batchRepairDepth: async (projectId: number | string): Promise<{
    success: boolean;
    projectId: number;
    totalImages: number;
    /** 成功写入的 depth 条目数（按 role） */
    upserted: number;
    /** 至少有一条成功的图像张数 */
    repairedImages?: number;
    skipped: number;
    failed: number;
    failedDetails?: string[];
  }> => {
    const response = await apiClient.post('/depth/repair/batch', { projectId }, { timeout: 10 * 60 * 1000 });
    return response.data;
  },

  // 查询批量补全深度的进行中进度（轮询 depth_repair_records）
  getBatchRepairStatus: async (
    projectId: number | string,
    sinceMs: number,
  ): Promise<{
    success: boolean;
    projectId: number | string;
    totalImages: number;
    processedImages: number;
    doneImages: number;
    failedImages: number;
  }> => {
    const response = await apiClient.get('/depth/repair/batch/status', {
      params: { projectId, sinceMs },
    });
    return response.data;
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
  getAutoAnnotateQueueStatus: async (taskId?: string): Promise<any> => {
    const response = await apiClient.get('/annotate/queue-status', {
      params: taskId ? { taskId } : undefined,
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
  deleteInitialPose: async (
    imageId: number | string,
    meshId: number | string,
    maskId?: string | null,
  ): Promise<any> => {
    const params: any = { meshId };
    if (maskId != null && String(maskId).trim()) params.maskId = String(maskId).trim();
    const response = await apiClient.delete(`/pose9d/${imageId}/initial-pose`, { params });
    return response.data;
  },
  getPose9D: async (
    imageId: number | string,
    meshId?: number | string | null,
    maskId?: string | null,
  ): Promise<any> => {
    const params: any = {};
    if (meshId != null) params.meshId = meshId;
    if (maskId != null && String(maskId).trim()) params.maskId = String(maskId).trim();
    const response = await apiClient.get(`/pose9d/${imageId}`, { params: Object.keys(params).length ? params : undefined });
    return response.data;
  },
  listPose9D: async (imageId: number | string): Promise<any> => {
    const response = await apiClient.get(`/pose9d/${imageId}/all`);
    return response.data;
  },
  deletePose9D: async (
    imageId: number | string,
    meshId?: number | string | null,
    maskId?: string | null,
  ): Promise<any> => {
    const params: any = {};
    if (meshId != null) params.meshId = meshId;
    if (maskId != null && String(maskId).trim()) params.maskId = String(maskId).trim();
    const response = await apiClient.delete(`/pose9d/${imageId}`, { params: Object.keys(params).length ? params : undefined });
    return response.data;
  },
  clear6dByImageId: async (imageId: number | string): Promise<any> => {
    const response = await apiClient.delete(`/pose9d/${imageId}/clear-6d`);
    return response.data;
  },
  saveDiffdopePose44: async (
    imageId: number | string,
    meshId: number | string,
    pose44: number[][],
    maskId?: string | null,
    options?: { skipFitOverlay?: boolean },
  ): Promise<any> => {
    const payload: any = { pose44 };
    if (maskId != null && String(maskId).trim()) payload.maskId = String(maskId).trim();
    if (options?.skipFitOverlay === true) payload.skipFitOverlay = true;
    const response = await apiClient.post(`/pose9d/${imageId}/${meshId}/diffdope-pose44`, payload);
    return response.data;
  },

  // 清空“最终位姿”（diffdope_json）。写入 '{}' 以确保前端把 final 视为不存在。
  clearDiffdopePose44: async (
    imageId: number | string,
    meshId: number | string,
    maskId?: string | null,
  ): Promise<any> => {
    const params: any = {};
    if (maskId != null && String(maskId).trim()) params.maskId = String(maskId).trim();
    const response = await apiClient.delete(`/pose9d/${imageId}/${meshId}/diffdope-pose44`, { params: Object.keys(params).length ? params : undefined });
    return response.data;
  },

  // 只对当前 image 的所有 diffdope 记录做一次拟合图层合成（生成并回写 fit_overlay_path）
  regenerateCompositeFitOverlay: async (imageId: number | string): Promise<any> => {
    const response = await apiClient.post(`/pose9d/${imageId}/regenerate-fit-overlay`);
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
      stage1UseMask?: boolean;
      stage1UseRgb?: boolean;
      stage2UseMask?: boolean;
      stage2UseRgb?: boolean;
      stage2UseDepth?: boolean;
      weightMask?: number;
      weightRgb?: number;
      weightDepth?: number;
      stage1WeightMask?: number;
      stage1WeightRgb?: number;
      stage2WeightMask?: number;
      stage2WeightDepth?: number;
      /** 第二轮 RGB 权重；旧客户端可仍传 weightRgb，由 Node 层映射 */
      stage2WeightRgb?: number;
      stage1EarlyStopLoss?: number | null;
      stage2EarlyStopLoss?: number | null;
      stage1BaseLr?: number;
      stage1LrDecay?: number;
      stage2BaseLr?: number;
      stage2LrDecay?: number;
      maxAllowedFinalLoss?: number | null;
      targetLabel?: string | null;
      useInitialPose?: boolean;
      onlySingleMesh?: boolean;
      targetMeshId?: number | null;
      depthSource?: 'raw' | 'fix';
      returnDebugImages?: boolean;
    },
  ): Promise<any> => {
    const response = await apiClient.post(`/pose6d/${imageId}/diffdope-estimate`, payload || {}, { timeout: 10 * 60 * 1000 });
    return response.data;
  },
  diffdopeProgress: async (imageId: number | string): Promise<any> => {
    const response = await apiClient.get(`/pose6d/${imageId}/diffdope-progress`);
    return response.data;
  },
  diffdopeQueueStatus: async (): Promise<any> => {
    const response = await apiClient.get('/pose6d/queue-status');
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
    const response = await apiClient.post(`/pose9d/${imageId}/fit-rotation`, payload, { timeout: 120000 });
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
    // 该接口在压力测试下可能因 SQLite I/O/锁竞争变慢，
    // 提高超时时间以避免前端误判“超时->掉线”。
    const response = await apiClient.get<{ success: boolean; summary: ProjectAnnotationSummary }>(
      `/projects/${projectId}/annotation-summary`,
      { timeout: 60000 },
    );
    return response.data.summary;
  },

  getLabelColors: async (projectId: number): Promise<ProjectLabelColorMapping[]> => {
    const response = await apiClient.get<{ success: boolean; mappings: ProjectLabelColorMapping[] }>(
      `/projects/${projectId}/label-colors`,
    );
    return Array.isArray(response.data?.mappings) ? response.data.mappings : [];
  },

  saveLabelColors: async (
    projectId: number,
    mappings: Array<{ label: string; labelZh?: string; color: string; usageOrder?: number }>,
  ): Promise<ProjectLabelColorMapping[]> => {
    const response = await apiClient.put<{ success: boolean; mappings: ProjectLabelColorMapping[] }>(
      `/projects/${projectId}/label-colors`,
      { mappings },
    );
    return Array.isArray(response.data?.mappings) ? response.data.mappings : [];
  },
};

export const projectSessionApi = {
  claim: async (projectId: number | string): Promise<{ success: boolean; projectId: number; controlled: boolean }> => {
    const response = await apiClient.post('/project-session/claim', { projectId });
    return response.data;
  },
  status: async (projectId: number | string): Promise<{ success: boolean; projectId: number; controlled: boolean }> => {
    const response = await apiClient.get('/project-session/status', { params: { projectId } });
    return response.data;
  },
  release: async (projectId: number | string): Promise<{ success: boolean; projectId: number; released: boolean }> => {
    const response = await apiClient.post('/project-session/release', { projectId });
    return response.data;
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
  verifyCode: async (
    accessCode: string,
  ): Promise<
    | { success: true; project: Project }
    | { success: false; status: number; error?: string; message?: string }
  > => {
    const response = await apiClient.post('/auth/verify-code', { accessCode }, {
      // 404/403 属于“预期业务分支”，不抛异常，交给页面逻辑处理
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status >= 200 && response.status < 300) {
      const data: any = response.data;
      if (data && data.success === false) {
        return {
          success: false,
          status: response.status,
          error: data?.error,
          message: data?.message,
        };
      }
      return data as { success: true; project: Project };
    }

    return {
      success: false,
      status: response.status,
      error: (response.data as any)?.error,
      message: (response.data as any)?.message,
    };
  },

  // 人机验证：获取挑战
  startHumanVerification: async (
    purpose: 'verifyCode' | 'adminLogin',
  ): Promise<{
    challengeId: string;
    purpose: string;
    width: number;
    height: number;
    x: number;
    y: number;
    imageSrc: string;
  }> => {
    const response = await apiClient.post<{
      challengeId: string;
      purpose: string;
      width: number;
      height: number;
      x: number;
      y: number;
      imageSrc: string;
    }>(
      '/auth/human-challenge',
      { purpose },
    );
    return response.data;
  },

  // 人机验证：提交答案
  verifyHumanVerification: async (payload: {
    challengeId: string;
    purpose: 'verifyCode' | 'adminLogin';
    sliderLeft: number;
    trail: number[];
    durationMs: number;
  }): Promise<{ success: boolean }> => {
    const response = await apiClient.post<{ success: boolean }>('/auth/human-verify', payload);
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
  checkAuth: async (): Promise<{
    authenticated: boolean;
    isAdmin?: boolean;
    user?: { id: number; username: string };
    requireHumanVerification?: { verifyCode?: boolean; adminLogin?: boolean };
  }> => {
    const response = await apiClient.get<{
      authenticated: boolean;
      isAdmin?: boolean;
      user?: { id: number; username: string };
      requireHumanVerification?: { verifyCode?: boolean; adminLogin?: boolean };
    }>('/auth/check');
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
  },

  /** 全应用调试分级（管理员） */
  getDebugSettings: async (): Promise<DebugSettingsPayload> => {
    const response = await apiClient.get('/admin/debug-settings');
    return response.data;
  },

  putDebugSettings: async (body: DebugSettingsPayload): Promise<DebugSettingsPayload> => {
    const response = await apiClient.put('/admin/debug-settings', body);
    return response.data;
  },
};

export default apiClient;