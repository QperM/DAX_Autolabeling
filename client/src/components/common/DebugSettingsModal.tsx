import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../../services/api';
import {
  type DebugServiceId,
  type DebugSettingsPayload,
  type DebugKind,
  DEFAULT_DEBUG_SETTINGS,
  normalizeDebugSettings,
  readDebugSettingsFromStorage,
  writeDebugSettingsToStorage,
  DEBUG_KINDS_BY_SERVICE,
} from '../../utils/debugSettings';
import './DebugSettingsModal.css';

const SERVICE_ROWS: { id: DebugServiceId; title: string; hint: string }[] = [
  { id: 'frontend', title: '前端（浏览器）', hint: '控制台中由 `debugLog("frontend", …)` 等控制的输出' },
  { id: 'node', title: 'Node 后端 API', hint: 'Express 进程内按服务 id `node` 分级的日志' },
  { id: 'sam2', title: '图像分割服务', hint: '独立进程；建议在服务内读取同源配置或环境变量与下表对齐' },
  { id: 'diffdope', title: '姿态标注服务', hint: 'DiffDope / pose-service；可将阈值写入环境变量或启动脚本' },
  { id: 'depthRepair', title: '深度修复服务', hint: '深度补全相关微服务' },
];

type Props = {
  open: boolean;
  onClose: () => void;
  isAdmin: boolean;
};

const DebugSettingsModal: React.FC<Props> = ({ open, onClose, isAdmin }) => {
  const [settings, setSettings] = useState<DebugSettingsPayload>(() => ({
    ...DEFAULT_DEBUG_SETTINGS,
    services: { ...DEFAULT_DEBUG_SETTINGS.services },
  }));
  const [modeByService, setModeByService] = useState<Record<DebugServiceId, 'off' | 'custom'>>(() => ({
    frontend: 'off',
    node: 'off',
    sam2: 'off',
    diffdope: 'off',
    depthRepair: 'off',
  }));
  const [kindPickerFor, setKindPickerFor] = useState<DebugServiceId | null>(null);
  const [kindPickerTempKinds, setKindPickerTempKinds] = useState<DebugKind[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showReLoginPrompt, setShowReLoginPrompt] = useState(false);
  const [pendingServerSave, setPendingServerSave] = useState<DebugSettingsPayload | null>(null);

  const hardReloadToEntry = () => {
    // 服务保存可能触发后端/子服务重启；这里给一点时间，避免刷新过早导致鉴权状态尚未失效。
    window.setTimeout(() => {
      window.location.reload();
    }, 500);
  };

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      if (isAdmin) {
        const remote = await adminApi.getDebugSettings();
        const merged = normalizeDebugSettings(remote);
        writeDebugSettingsToStorage(merged);
        setSettings(merged);
        setModeByService((prev) => {
          const next = { ...prev };
          (Object.keys(merged.services) as DebugServiceId[]).forEach((id) => {
            next[id] = merged.services[id]?.length ? 'custom' : 'off';
          });
          return next;
        });
      } else {
        const local = readDebugSettingsFromStorage();
        const merged = normalizeDebugSettings(local);
        setSettings(merged);
        setModeByService((prev) => {
          const next = { ...prev };
          (Object.keys(merged.services) as DebugServiceId[]).forEach((id) => {
            next[id] = merged.services[id]?.length ? 'custom' : 'off';
          });
          return next;
        });
        setError('只读：未使用管理员登录，未尝试从服务器加载');
      }
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!open) return;
    setShowReLoginPrompt(false);
    setPendingServerSave(null);
    setKindPickerFor(null);
    setKindPickerTempKinds([]);
    setError('');
    setSaving(false);
    void load();
  }, [open, load]);

  const openReLoginPromptWithPending = (next: DebugSettingsPayload) => {
    setError('');
    setPendingServerSave(normalizeDebugSettings(next));
    // 避免“种类选择弹窗 + 二次确认弹窗”叠加
    closeKindPicker();
    setShowReLoginPrompt(true);
  };

  const openKindPicker = (service: DebugServiceId) => {
    console.log('[DebugSettingsModal] openKindPicker', { service, kinds: DEBUG_KINDS_BY_SERVICE[service]?.map((x) => x.kind) });
    setKindPickerFor(service);
    setKindPickerTempKinds([...(settings.services[service] || [])]);
  };

  useEffect(() => {
    if (!kindPickerFor) return;
    console.log('[DebugSettingsModal] kindPickerFor render', {
      kindPickerFor,
      renderedKinds: DEBUG_KINDS_BY_SERVICE[kindPickerFor]?.map((x) => x.kind),
    });
  }, [kindPickerFor]);

  const closeKindPicker = () => {
    setKindPickerFor(null);
    setKindPickerTempKinds([]);
  };

  const getServiceTitle = (id: DebugServiceId) => {
    return SERVICE_ROWS.find((r) => r.id === id)?.title || id;
  };

  const handleModeChange = (id: DebugServiceId, nextMode: 'off' | 'custom') => {
    if (showReLoginPrompt) return;

    if (nextMode === 'off') {
      setModeByService((prev) => ({ ...prev, [id]: 'off' }));
      setSettings((prev) => ({
        ...prev,
        services: { ...prev.services, [id]: [] },
      }));
      if (kindPickerFor === id) closeKindPicker();
      return;
    }

    setModeByService((prev) => ({ ...prev, [id]: 'custom' }));
    // custom 模式下不强制勾选任何种类；用户可继续选择种类
  };

  const requestServerSave = () => {
    if (showReLoginPrompt) return;
    openReLoginPromptWithPending(settings);
  };

  const performServerSave = async (payload: DebugSettingsPayload) => {
    setSaving(true);
    setError('');
    try {
      // 在二次确认后才落地本机配置，让前端 debugLog 立即生效。
      writeDebugSettingsToStorage(payload);
      const saved = await adminApi.putDebugSettings(payload);
      const merged = normalizeDebugSettings(saved);
      writeDebugSettingsToStorage(merged);
      setSettings(merged);
      setPendingServerSave(null);
    } catch {
      setPendingServerSave(null);
      // 不再做“权限鉴定/提示停留”：无论成功失败，统一引导用户重新登录。
    } finally {
      setSaving(false);
    }
    hardReloadToEntry();
  };

  const handleResetLocal = () => {
    const d = {
      ...DEFAULT_DEBUG_SETTINGS,
      services: { ...DEFAULT_DEBUG_SETTINGS.services },
    };
    setSettings(d);
    setModeByService({
      frontend: 'off',
      node: 'off',
      diffdope: 'off',
      sam2: 'off',
      depthRepair: 'off',
    });
    writeDebugSettingsToStorage(d);
  };

  if (!open) return null;

  return (
    <>
      <div className="debug-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="debug-settings-title">
        <div className="debug-settings-modal">
        <div className="debug-settings-header">
          <h2 id="debug-settings-title">调试信息管理</h2>
          <button type="button" className="debug-settings-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="debug-settings-body">
          <p className="debug-settings-lead">
            通过勾选每个服务需要输出的<strong>调试种类</strong>。未勾选的调试信息不会打印到控制台。
          </p>

          <div className="debug-settings-table-wrap">
            <table className="debug-settings-table">
              <thead>
                <tr>
                  <th scope="col">服务</th>
                  <th scope="col">说明</th>
                  <th scope="col">调试信息状态</th>
                </tr>
              </thead>
              <tbody>
                {SERVICE_ROWS.map((row) => (
                  <tr key={row.id}>
                    <td className="debug-settings-col-title">{row.title}</td>
                    <td className="debug-settings-col-hint">{row.hint}</td>
                    <td>
                      <div className="debug-settings-kind-cell">
                        <select
                          className="debug-settings-select"
                          value={modeByService[row.id]}
                          onChange={(e) => handleModeChange(row.id, e.target.value as 'off' | 'custom')}
                          disabled={!isAdmin || loading || !!kindPickerFor || showReLoginPrompt}
                        >
                          <option value="off">关闭</option>
                          <option value="custom">开启</option>
                        </select>

                        {modeByService[row.id] === 'custom' && (
                          <button
                            type="button"
                            className="debug-settings-kinds-btn"
                            onClick={() => openKindPicker(row.id)}
                            disabled={!isAdmin || loading || showReLoginPrompt}
                            title="选择该服务需要输出的调试种类"
                          >
                            输出种类
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {settings.updatedAt && (
            <p className="debug-settings-meta">上次更新（服务器）：{new Date(settings.updatedAt).toLocaleString()}</p>
          )}

          {error && <div className="debug-settings-error">{error}</div>}

        </div>

        <div className="debug-settings-footer">
          <button type="button" className="debug-settings-btn secondary" onClick={onClose}>
            关闭
          </button>
          {!isAdmin && (
            <span className="debug-settings-readonly">只读：请使用管理员登录后可保存到服务器</span>
          )}
          {isAdmin && (
            <>
              <button
                type="button"
                className="debug-settings-btn secondary"
                onClick={handleResetLocal}
                disabled={saving || loading || showReLoginPrompt}
              >
                恢复默认
              </button>
              <button
                type="button"
                className="debug-settings-btn primary"
                onClick={requestServerSave}
                disabled={saving || loading || showReLoginPrompt}
              >
                {saving ? '保存中…' : '保存到服务器'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>

      {kindPickerFor && (
        <div
          className="debug-kind-picker-overlay"
          onClick={() => closeKindPicker()}
          role="presentation"
        >
          <div
            className="debug-kind-picker-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="debug-kind-picker-header">
              <div className="debug-kind-picker-title">
                  选择「{getServiceTitle(kindPickerFor)}」的调试种类
              </div>
              <button type="button" className="debug-settings-close" onClick={closeKindPicker} aria-label="关闭">
                ×
              </button>
            </div>

            <div className="debug-kind-picker-body">
              <div className="debug-settings-kinds">
                {DEBUG_KINDS_BY_SERVICE[kindPickerFor].map((k) => {
                  const checked = kindPickerTempKinds.includes(k.kind);
                  return (
                    <label key={k.kind} className="debug-settings-kind-row" title={k.hint}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const nextChecked = e.target.checked;
                          setKindPickerTempKinds((prev) => {
                            if (nextChecked) return Array.from(new Set([...prev, k.kind]));
                            return prev.filter((x) => x !== k.kind);
                          });
                        }}
                      />
                      <span>{k.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="debug-kind-picker-footer">
              <button type="button" className="debug-settings-btn secondary" onClick={closeKindPicker} disabled={saving || loading}>
                取消
              </button>
              <button
                type="button"
                className="debug-settings-btn primary"
                disabled={!isAdmin || saving || loading}
                onClick={() => {
                  if (!kindPickerFor) return;
                  const next = {
                    ...settings,
                    services: { ...settings.services, [kindPickerFor]: kindPickerTempKinds },
                  };
                  // 仅更新前端“草稿”状态；真正落地与重启在二次确认后进行
                  setSettings(next);
                  closeKindPicker();
                }}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {showReLoginPrompt && (
        <div
          className="debug-kind-picker-overlay"
          role="presentation"
          style={{ zIndex: 10055, alignItems: 'center', paddingTop: 0 }}
          onClick={() => {
            // Cancel: keep the debug modal open.
            setShowReLoginPrompt(false);
            setPendingServerSave(null);
          }}
        >
          <div
            className="debug-kind-picker-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(560px, 94%)' }}
          >
            <div
              className="debug-kind-picker-body"
              style={{
                paddingTop: '0.25rem',
                color: '#0f172a',
                fontWeight: 600,
                lineHeight: 1.35,
              }}
            >
              开发环境保存调试配置时可能触发服务重启，导致管理员登录态失效。请重新登录管理员后继续。
            </div>
            <div className="debug-kind-picker-footer">
              <button
                type="button"
                className="debug-settings-btn secondary"
                onClick={() => {
                  setShowReLoginPrompt(false);
                  setPendingServerSave(null);
                }}
                disabled={saving || loading}
              >
                取消
              </button>
              <button
                type="button"
                className="debug-settings-btn primary"
                onClick={() => {
                  if (!pendingServerSave) return;
                  void performServerSave(pendingServerSave);
                }}
                disabled={saving || loading}
              >
                确认并重新登录
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default DebugSettingsModal;
