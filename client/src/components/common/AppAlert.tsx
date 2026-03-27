import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './AppAlert.css';

type AlertState = {
  open: boolean;
  mode?: 'alert' | 'confirm';
  title?: string;
  message: React.ReactNode;
};

type AlertApi = {
  alert: (message: React.ReactNode, opts?: { title?: string; okText?: string }) => Promise<void>;
  confirm: (
    message: React.ReactNode,
    opts?: { title?: string; okText?: string; cancelText?: string },
  ) => Promise<boolean>;
};

const AlertContext = createContext<AlertApi | null>(null);

export function useAppAlert(): AlertApi {
  const ctx = useContext(AlertContext);
  if (!ctx) {
    throw new Error('useAppAlert must be used within <AppAlertProvider>.');
  }
  return ctx;
}

export const AppAlertProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AlertState>({ open: false, mode: 'alert', message: '' });
  const [okText, setOkText] = useState('OK');
  const [cancelText, setCancelText] = useState('Cancel');
  const resolverRef = useRef<(() => void) | null>(null);
  const confirmResolverRef = useRef<((v: boolean) => void) | null>(null);

  const closeAlert = useCallback(() => {
    setState((s) => ({ ...s, open: false }));
    const r = resolverRef.current;
    resolverRef.current = null;
    if (r) r();
  }, []);

  const closeConfirm = useCallback((ok: boolean) => {
    setState((s) => ({ ...s, open: false }));
    const r = confirmResolverRef.current;
    confirmResolverRef.current = null;
    if (r) r(ok);
  }, []);

  const api = useMemo<AlertApi>(() => {
    return {
      alert: (message, opts) =>
        new Promise<void>((resolve) => {
          resolverRef.current = resolve;
          setOkText((opts?.okText || 'OK').trim() || 'OK');
          setState({
            open: true,
            mode: 'alert',
            title: opts?.title,
            message,
          });
        }),
      confirm: (message, opts) =>
        new Promise<boolean>((resolve) => {
          confirmResolverRef.current = resolve;
          setOkText((opts?.okText || 'OK').trim() || 'OK');
          setCancelText((opts?.cancelText || 'Cancel').trim() || 'Cancel');
          setState({
            open: true,
            mode: 'confirm',
            title: opts?.title,
            message,
          });
        }),
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!state.open) return;
      if (state.mode === 'confirm') {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeConfirm(false);
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          closeConfirm(true);
        }
        return;
      }
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        closeAlert();
      }
    },
    [state.open, state.mode, closeAlert, closeConfirm]
  );

  return (
    <AlertContext.Provider value={api}>
      {children}
      {state.open &&
        createPortal(
          <div className="app-alert-overlay" role="dialog" aria-modal="true" onKeyDown={handleKeyDown} tabIndex={-1}>
            <div className="app-alert-modal">
              {state.title ? <div className="app-alert-title">{state.title}</div> : <div className="app-alert-title">提示</div>}
              <div className="app-alert-body">{state.message}</div>
              <div className="app-alert-actions">
                {state.mode === 'confirm' ? (
                  <>
                    <button
                      type="button"
                      className="app-alert-btn app-alert-btn--secondary"
                      onClick={() => closeConfirm(false)}
                    >
                      {cancelText}
                    </button>
                    <button type="button" className="app-alert-btn" onClick={() => closeConfirm(true)} autoFocus>
                      {okText}
                    </button>
                  </>
                ) : (
                  <button type="button" className="app-alert-btn" onClick={closeAlert} autoFocus>
                    {okText}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </AlertContext.Provider>
  );
};

