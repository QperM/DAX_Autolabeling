import React from 'react';
import { createPortal } from 'react-dom';
import './ProgressPopupModal.css';

export type ProgressPopupTone = 'primary' | 'extract';

export type ProgressPopupBar = {
  key: string;
  title: string;
  percent: number; // 0-100
  tone?: ProgressPopupTone;
  currentText?: string;
};

export type ProgressPopupModalProps = {
  open: boolean;
  title?: string;
  bars: ProgressPopupBar[];
  message?: string;
  summary?: React.ReactNode;
  closable?: boolean;
  onClose?: () => void;
};

const clampPercent = (v: number) => {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
};

export const ProgressPopupModal: React.FC<ProgressPopupModalProps> = ({
  open,
  title,
  bars,
  message,
  summary,
}) => {
  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="progress-popup-layer" role="dialog" aria-modal="false">
      <div className="progress-popup-modal">
        <div className="progress-popup-header">
          <div className="progress-popup-title">{title || '处理中...'}</div>
        </div>

        <div className="progress-popup-body">
          {bars.map((bar) => {
            const pct = clampPercent(bar.percent);
            return (
              <div className="progress-popup-section" key={bar.key}>
                <div className="progress-popup-row">
                  <div className="progress-popup-label">{bar.title}</div>
                  <div className="progress-popup-pct">{Math.round(pct)}%</div>
                </div>

                <div className="progress-popup-bar">
                  <div
                    className={[
                      'progress-popup-fill',
                      bar.tone === 'extract' ? 'progress-popup-fill--extract' : 'progress-popup-fill--primary',
                    ].join(' ')}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {bar.currentText && <div className="progress-popup-current">{bar.currentText}</div>}
              </div>
            );
          })}

          {message && <div className="progress-popup-message">{message}</div>}
          {summary && <div className="progress-popup-summary">{summary}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
};

