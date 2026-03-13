// URL helpers shared across components.
//
// In dev (Vite 5173), the API/uploads are served by the Node backend on 3001.
// In production (Docker/K8s), the web server (Nginx) reverse-proxies /api and /uploads,
// so the frontend should use relative paths instead of http://localhost:3001.

const DEV_BACKEND_ORIGIN = 'http://localhost:3001';

export function toAbsoluteUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (/^(blob:|data:|https?:\/\/)/i.test(url)) return url;
  const base = import.meta.env.MODE === 'development' ? DEV_BACKEND_ORIGIN : '';
  return `${base}${url}`;
}

