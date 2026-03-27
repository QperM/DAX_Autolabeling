import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectSessionApi } from '../services/api';
import { useAppAlert } from '../components/common/AppAlert';
import { clearStoredCurrentProject, clearStoredSelectedModules } from './tabStorage';
import { debugLog } from './debugSettings';

const DEFAULT_DISCONNECT_MSG = '有其他人操作此项目了，当前连接已断开。';

export function useProjectSessionGuard(projectId: number | null | undefined, enabled = true) {
  const navigate = useNavigate();
  const { alert } = useAppAlert();
  const disconnectedRef = useRef(false);

  useEffect(() => {
    disconnectedRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!enabled) return;
    const pid = Number(projectId);
    if (!pid || Number.isNaN(pid)) return;

    let timer: number | null = null;
    let cancelled = false;

    const disconnect = async (message?: string) => {
      if (cancelled || disconnectedRef.current) return;
      disconnectedRef.current = true;
      debugLog('frontend', 'frontendProjectSessionGuard', '[projectSessionGuard] disconnect', {
        projectId: pid,
        message: message || DEFAULT_DISCONNECT_MSG,
      });
      clearStoredCurrentProject();
      clearStoredSelectedModules();
      try {
        await alert(message || DEFAULT_DISCONNECT_MSG);
      } catch (_) {}
      navigate('/', { replace: true });
    };

    const handleError = async (err: any) => {
      const data = err?.response?.data || {};
      const disconnectByCode = ['PROJECT_CONTROL_TAKEN', 'PROJECT_LOCKED', 'PROJECT_DELETED', 'PROJECT_ACCESS_REVOKED'];
      debugLog('frontend', 'frontendProjectSessionGuard', '[projectSessionGuard] api error', {
        projectId: pid,
        status: err?.response?.status,
        code: data?.code,
        disconnect: !!data?.disconnect,
      });
      if (data?.disconnect || disconnectByCode.includes(String(data?.code || ''))) {
        await disconnect(String(data?.message || data?.error || DEFAULT_DISCONNECT_MSG));
      }
    };

    const heartbeat = async () => {
      if (cancelled || disconnectedRef.current) return;
      try {
        debugLog('frontend', 'frontendProjectSessionGuard', '[projectSessionGuard] heartbeat', { projectId: pid });
        await projectSessionApi.status(pid);
      } catch (e: any) {
        await handleError(e);
      }
    };

    (async () => {
      try {
        debugLog('frontend', 'frontendProjectSessionGuard', '[projectSessionGuard] claim', { projectId: pid });
        await projectSessionApi.claim(pid);
      } catch (e: any) {
        await handleError(e);
        return;
      }
      await heartbeat();
      if (cancelled || disconnectedRef.current) return;
      timer = window.setInterval(() => {
        void heartbeat();
      }, 4000);
    })();

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      debugLog('frontend', 'frontendProjectSessionGuard', '[projectSessionGuard] release', { projectId: pid });
      void projectSessionApi.release(pid).catch(() => {});
    };
  }, [projectId, enabled, navigate, alert]);
}

