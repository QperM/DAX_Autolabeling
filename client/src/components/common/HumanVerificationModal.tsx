import React, { useEffect, useMemo, useState } from 'react';
import { authApi } from '../../services/api';
import './HumanVerificationModal.css';
import SliderJigsawCaptcha, { type SliderJigsawChallenge, type SliderJigsawProof } from './SliderJigsawCaptcha';

export type HumanVerificationPurpose = 'verifyCode' | 'adminLogin';

type Props = {
  open: boolean;
  purpose: HumanVerificationPurpose;
  onVerified: () => void | Promise<void>;
};

type SliderChallenge = {
  challengeId: string;
  purpose: string;
  width: number;
  height: number;
  x: number;
  y: number;
  imageSrc: string;
};

const HumanVerificationModal: React.FC<Props> = ({ open, purpose, onVerified }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [challenge, setChallenge] = useState<SliderChallenge | null>(null);

  const activePurpose = useMemo(() => purpose, [purpose]);

  const loadChallenge = async () => {
    setError('');
    setChallenge(null);
    setLoading(true);
    try {
      const res = await authApi.startHumanVerification(activePurpose);
      setChallenge(res);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || '获取人机验证挑战失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadChallenge();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activePurpose]);

  const handleCaptchaSuccess = async (proof: SliderJigsawProof) => {
    if (!challenge) return;
    setError('');
    setVerifying(true);
    try {
      const res = await authApi.verifyHumanVerification({
        challengeId: challenge.challengeId,
        purpose: activePurpose,
        sliderLeft: proof.sliderLeft,
        trail: proof.trail,
        durationMs: proof.durationMs,
      });
      if (res.success) {
        await onVerified();
        return;
      }
      setError('后端校验失败，请重试');
      await loadChallenge();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || '后端校验失败，请重试');
      await loadChallenge();
    } finally {
      setVerifying(false);
    }
  };

  if (!open) return null;

  return (
    <div className="human-verify-overlay" role="dialog" aria-modal="true">
      <div className="human-verify-modal">
        <div className="human-verify-header">
          <h2>人机验证</h2>
        </div>

        <div className="human-verify-body">
          {loading && <div className="human-verify-loading">加载中…</div>}

          {!loading && challenge && (
            <div className="human-verify-slider-wrap">
              <div className="human-verify-captcha-host">
                <SliderJigsawCaptcha
                  challenge={challenge as unknown as SliderJigsawChallenge}
                  disableRefresh
                  onSuccess={(proof) => void handleCaptchaSuccess(proof)}
                  onFail={() => setError('验证失败，请再试一次')}
                />
              </div>
            </div>
          )}

          {verifying && <div className="human-verify-loading human-verify-verifying">验证中…</div>}
          {error && <div className="human-verify-error">{error}</div>}
        </div>

        <div className="human-verify-actions">
          <button
            type="button"
            className="human-verify-btn secondary"
            onClick={() => void loadChallenge()}
            disabled={verifying || loading}
            title="重新获取拼图挑战"
          >
            刷新
          </button>
        </div>
      </div>
    </div>
  );
};

export default HumanVerificationModal;

