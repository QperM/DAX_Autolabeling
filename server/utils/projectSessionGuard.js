const { debugLog } = require('./debugSettingsStore');
const PROJECT_SESSION_CODE = {
  TAKEN: 'PROJECT_CONTROL_TAKEN',
  LOCKED: 'PROJECT_LOCKED',
  DELETED: 'PROJECT_DELETED',
};

function makeProjectSessionGuard() {
  const activeByProject = new Map(); // projectId -> { sessionId, at }
  const revokedBySessionProject = new Map(); // `${sessionId}:${projectId}` -> { code, message, at }

  const keyOf = (sessionId, projectId) => `${String(sessionId)}:${Number(projectId)}`;

  const revoke = (sessionId, projectId, code, message) => {
    debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.revoke]', {
      sessionId: String(sessionId),
      projectId: Number(projectId),
      code,
      message,
    });
    revokedBySessionProject.set(keyOf(sessionId, projectId), {
      code,
      message,
      at: Date.now(),
    });
  };

  const claim = ({ sessionId, projectId }) => {
    const pid = Number(projectId);
    if (!sessionId || !pid || Number.isNaN(pid)) return { ok: false, code: 'INVALID_PROJECT', message: 'projectId 非法' };
    const now = Date.now();
    const prev = activeByProject.get(pid);
    if (prev && prev.sessionId && prev.sessionId !== sessionId) {
      debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.claim] takeover', {
        projectId: pid,
        previousSessionId: String(prev.sessionId),
        nextSessionId: String(sessionId),
      });
      revoke(
        prev.sessionId,
        pid,
        PROJECT_SESSION_CODE.TAKEN,
        '有其他人操作此项目了，当前连接已断开。',
      );
    }
    debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.claim] active', {
      projectId: pid,
      sessionId: String(sessionId),
    });
    activeByProject.set(pid, { sessionId, at: now });
    revokedBySessionProject.delete(keyOf(sessionId, pid));
    return { ok: true };
  };

  const release = ({ sessionId, projectId }) => {
    const pid = Number(projectId);
    if (!sessionId || !pid || Number.isNaN(pid)) return;
    const prev = activeByProject.get(pid);
    if (prev?.sessionId === sessionId) {
      debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.release]', {
        projectId: pid,
        sessionId: String(sessionId),
      });
      activeByProject.delete(pid);
    }
    revokedBySessionProject.delete(keyOf(sessionId, pid));
  };

  const releaseAllForSession = ({ sessionId }) => {
    if (!sessionId) return;
    debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.releaseAllForSession] start', {
      sessionId: String(sessionId),
    });
    for (const [projectId, holder] of activeByProject.entries()) {
      if (holder?.sessionId === sessionId) activeByProject.delete(projectId);
    }
    const prefix = `${String(sessionId)}:`;
    for (const k of revokedBySessionProject.keys()) {
      if (k.startsWith(prefix)) revokedBySessionProject.delete(k);
    }
  };

  const invalidateProject = ({ projectId, code, message }) => {
    const pid = Number(projectId);
    if (!pid || Number.isNaN(pid)) return;
    const prev = activeByProject.get(pid);
    if (prev?.sessionId) {
      debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.invalidateProject]', {
        projectId: pid,
        sessionId: String(prev.sessionId),
        code: code || PROJECT_SESSION_CODE.DELETED,
        message: message || '项目已失效，当前连接已断开。',
      });
      revoke(
        prev.sessionId,
        pid,
        code || PROJECT_SESSION_CODE.DELETED,
        message || '项目已失效，当前连接已断开。',
      );
      activeByProject.delete(pid);
    }
  };

  const check = ({ sessionId, projectId }) => {
    const pid = Number(projectId);
    if (!sessionId || !pid || Number.isNaN(pid)) return { ok: false, code: 'INVALID_PROJECT', message: 'projectId 非法' };
    const revoked = revokedBySessionProject.get(keyOf(sessionId, pid));
    if (revoked) {
      debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.check] revoked', {
        projectId: pid,
        sessionId: String(sessionId),
        code: revoked.code,
      });
      return {
        ok: false,
        code: revoked.code || PROJECT_SESSION_CODE.TAKEN,
        message: revoked.message || '有其他人操作此项目了，当前连接已断开。',
        disconnect: true,
      };
    }
    const active = activeByProject.get(pid);
    if (!active) return { ok: true, activeSessionId: null };
    if (active.sessionId !== sessionId) {
      debugLog('node', 'nodeProjectSessionGuard', '[projectSessionGuard.check] holder_mismatch', {
        projectId: pid,
        expectedSessionId: String(active.sessionId),
        actualSessionId: String(sessionId),
      });
      return {
        ok: false,
        code: PROJECT_SESSION_CODE.TAKEN,
        message: '有其他人操作此项目了，当前连接已断开。',
        disconnect: true,
      };
    }
    return { ok: true, activeSessionId: active.sessionId };
  };

  return {
    PROJECT_SESSION_CODE,
    claim,
    release,
    releaseAllForSession,
    invalidateProject,
    check,
  };
}

module.exports = {
  makeProjectSessionGuard,
  PROJECT_SESSION_CODE,
};

