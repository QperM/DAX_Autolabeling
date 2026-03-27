import React, { useEffect, useRef } from 'react';
import './SliderJigsawCaptcha.css';
import { debugLog } from '../../utils/debugSettings';

export type SliderJigsawChallenge = {
  challengeId: string;
  purpose: string;
  width: number;
  height: number;
  x: number;
  y: number;
  imageSrc: string;
};

export type SliderJigsawProof = {
  sliderLeft: number;
  trail: number[];
  durationMs: number;
  stddev?: number;
};

type Props = {
  challenge: SliderJigsawChallenge;
  disableRefresh?: boolean;
  onSuccess: (proof: SliderJigsawProof) => void;
  onFail?: () => void;
  onRefresh?: () => void;
};

const l = 42; // 滑块边长
const r = 9; // 滑块半径
const PI = Math.PI;
const L = l + r * 2 + 3; // 滑块实际边长（用于裁剪/提取）

function sum(x: number, y: number) {
  return x + y;
}
function square(x: number) {
  return x * x;
}

function drawPath(ctx: CanvasRenderingContext2D, x: number, y: number, operation: 'fill' | 'clip') {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x + l / 2, y - r + 2, r, 0.72 * PI, 2.26 * PI);
  ctx.lineTo(x + l, y);
  ctx.arc(x + l + r - 2, y + l / 2, r, 1.21 * PI, 2.78 * PI);
  ctx.lineTo(x + l, y + l);
  ctx.lineTo(x, y + l);
  ctx.arc(x + r - 2, y + l / 2, r + 0.4, 2.76 * PI, 1.24 * PI, true);
  ctx.lineTo(x, y);
  ctx.lineWidth = 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.stroke();
  ctx.globalCompositeOperation = 'destination-over';
  if (operation === 'fill') ctx.fill();
  else ctx.clip();
}

const SliderJigsawCaptcha: React.FC<Props> = ({
  challenge,
  disableRefresh = false,
  onSuccess,
  onFail,
  onRefresh,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Cleanup before init
    host.innerHTML = '';

    const { width, height } = challenge;

    Object.assign(host.style, {
      position: 'relative',
      width: `${width}px`,
      margin: '0 auto',
    });

    // ===== DOM nodes (copied from jigsaw/src/jigsaw.js structure) =====
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const block = document.createElement('canvas');
    block.width = width;
    block.height = height;
    block.className = 'sj-block';

    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'sj-sliderContainer';
    sliderContainer.style.width = `${width}px`;
    sliderContainer.style.pointerEvents = 'none';

    const refreshIcon = disableRefresh ? null : document.createElement('div');
    if (refreshIcon) {
      refreshIcon.className = 'sj-refreshIcon';
    }

    const sliderMask = document.createElement('div');
    sliderMask.className = 'sj-sliderMask';

    const slider = document.createElement('div');
    slider.className = 'sj-slider';

    const sliderIcon = document.createElement('span');
    sliderIcon.className = 'sj-sliderIcon';

    const text = document.createElement('span');
    text.className = 'sj-sliderText';
    text.innerHTML = '向右滑动填充拼图';

    // loading overlay
    const loadingContainer = document.createElement('div');
    loadingContainer.className = 'sj-loadingContainer';
    loadingContainer.style.width = `${width}px`;
    loadingContainer.style.height = `${height}px`;

    const loadingIcon = document.createElement('div');
    loadingIcon.className = 'sj-loadingIcon';
    const loadingText = document.createElement('span');
    loadingText.innerHTML = '加载中...';

    loadingContainer.appendChild(loadingIcon);
    loadingContainer.appendChild(loadingText);

    slider.appendChild(sliderIcon);
    sliderMask.appendChild(slider);
    sliderContainer.appendChild(sliderMask);
    sliderContainer.appendChild(text);

    host.appendChild(loadingContainer);
    host.appendChild(canvas);
    if (refreshIcon) host.appendChild(refreshIcon);
    host.appendChild(block);
    host.appendChild(sliderContainer);

    const canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
    const blockCtx = block.getContext('2d', { willReadFrequently: true });
    if (!canvasCtx || !blockCtx) {
      loadingContainer.style.display = 'none';
      sliderContainer.style.pointerEvents = '';
      onFail?.();
      return;
    }

    // ===== Helpers =====
    const setLoadingDom = (isLoading: boolean) => {
      loadingContainer.style.display = isLoading ? '' : 'none';
      sliderContainer.style.pointerEvents = isLoading ? 'none' : '';
    };

    // keep a single Image instance for the current challenge
    let img: HTMLImageElement | null = null;
    const loadImg = () =>
      new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'Anonymous';
        image.onload = () => {
          img = image;
          resolve();
        };
        image.onerror = () => {
          // 首次 URL 失败时回退到 seed URL，并把信息纳入 debugLog（受调试面板控制）
          const fallback = `https://picsum.photos/seed/dax_hv_fallback_${challenge.challengeId}/${challenge.width}/${challenge.height}`;
          debugLog('frontend', 'landingPage', '[SliderJigsawCaptcha] 图片加载失败，尝试回退地址', {
            primary: challenge.imageSrc,
            fallback,
          });
          const retry = new Image();
          retry.crossOrigin = 'Anonymous';
          retry.onload = () => {
            img = retry;
            resolve();
          };
          retry.onerror = () => reject(new Error('图片加载失败'));
          retry.src = fallback;
        };
        image.src = challenge.imageSrc;
      });

    const draw = () => {
      const { x, y } = challenge;
      // clear
      canvasCtx.clearRect(0, 0, width, height);
      blockCtx.clearRect(0, 0, width, height);

      // create puzzle at deterministic x/y
      drawPath(canvasCtx, x, y, 'fill');
      drawPath(blockCtx, x, y, 'clip');

      if (!img) return;
      canvasCtx.drawImage(img, 0, 0, width, height);
      blockCtx.drawImage(img, 0, 0, width, height);

      // extract moving block
      const y2 = y - r * 2 - 1;
      const imageData = blockCtx.getImageData(x - 3, y2, L, L);
      block.width = L;
      blockCtx.putImageData(imageData, 0, y2);
    };

    const verify = (trail: number[]) => {
      if (!trail.length) return { spliced: false, verified: false, left: 0, stddev: 0 };
      const average = trail.reduce(sum) / trail.length;
      const deviations = trail.map((v) => v - average);
      const stddev = Math.sqrt(deviations.map(square).reduce(sum) / trail.length);
      const left = parseInt(block.style.left || '0', 10);
      return {
        spliced: Math.abs(left - challenge.x) < 10,
        verified: stddev !== 0,
        left,
        stddev,
      };
    };

    const reset = () => {
      trail.length = 0;
      isMouseDown = false;

      // reset style
      sliderContainer.className = 'sj-sliderContainer';
      slider.style.left = '0px';
      block.width = width;
      block.style.left = '0px';
      sliderMask.style.width = '0px';

      canvasCtx.clearRect(0, 0, width, height);
      blockCtx.clearRect(0, 0, width, height);

      setLoadingDom(true);
      void loadImg()
        .then(() => {
          setLoadingDom(false);
          draw();
        })
        .catch(() => {
          setLoadingDom(false);
          onFail?.();
        });
    };

    // ===== Event handlers =====
    host.onselectstart = () => false;

    if (refreshIcon) {
      refreshIcon.onclick = () => {
        reset();
        onRefresh?.();
      };
    }

    let originX = 0;
    let originY = 0;
    let isMouseDown = false;
    let dragStartTs: number | null = null;
    const trail: number[] = [];

    const handleDragStart = (e: MouseEvent | TouchEvent) => {
      const anyE = e as any;
      originX = anyE.clientX ?? anyE.touches?.[0]?.clientX;
      originY = anyE.clientY ?? anyE.touches?.[0]?.clientY;
      isMouseDown = true;
      dragStartTs = Date.now();
    };

    const handleDragMove = (e: MouseEvent | TouchEvent) => {
      if (!isMouseDown) return;
      e.preventDefault();

      const anyE = e as any;
      const eventX = anyE.clientX ?? anyE.touches?.[0]?.clientX;
      const eventY = anyE.clientY ?? anyE.touches?.[0]?.clientY;

      const moveX = eventX - originX;
      const moveY = eventY - originY;
      if (moveX < 0 || moveX + 38 >= width) return;

      slider.style.left = `${moveX}px`;
      const blockLeft = ((width - 40 - 20) / (width - 40)) * moveX;
      block.style.left = `${blockLeft}px`;

      sliderContainer.classList.add('sj-sliderContainer_active');
      sliderMask.style.width = `${moveX}px`;
      trail.push(moveY);
    };

    const handleDragEnd = (e: MouseEvent | TouchEvent) => {
      if (!isMouseDown) return;
      isMouseDown = false;

      const anyE = e as any;
      const eventX = anyE.clientX ?? anyE.changedTouches?.[0]?.clientX;
      if (eventX === originX) return;

      sliderContainer.classList.remove('sj-sliderContainer_active');
      const { spliced, verified, left, stddev } = verify(trail);
      const durationMs = dragStartTs ? Date.now() - dragStartTs : 0;

      if (spliced) {
        if (verified) {
          sliderContainer.classList.add('sj-sliderContainer_success');
          onSuccess({ sliderLeft: left, trail: [...trail], durationMs, stddev });
          return;
        }
        sliderContainer.classList.add('sj-sliderContainer_fail');
        text.innerHTML = '请再试一次';
        onFail?.();
        reset();
      } else {
        sliderContainer.classList.add('sj-sliderContainer_fail');
        onFail?.();
        setTimeout(reset, 1000);
      }
    };

    slider.addEventListener('mousedown', handleDragStart);
    slider.addEventListener('touchstart', handleDragStart as any, { passive: true });
    block.addEventListener('mousedown', handleDragStart);
    block.addEventListener('touchstart', handleDragStart as any, { passive: true });
    document.addEventListener('mousemove', handleDragMove as any);
    document.addEventListener('touchmove', handleDragMove as any, { passive: false });
    document.addEventListener('mouseup', handleDragEnd as any);
    document.addEventListener('touchend', handleDragEnd as any);

    // Initial load + draw
    setLoadingDom(true);
    let cancelled = false;
    void loadImg()
      .then(() => {
        if (cancelled) return;
        setLoadingDom(false);
        draw();
      })
      .catch(() => {
        if (cancelled) return;
        setLoadingDom(false);
        onFail?.();
      });

    // Cleanup
    return () => {
      cancelled = true;
      try {
        slider.removeEventListener('mousedown', handleDragStart);
        slider.removeEventListener('touchstart', handleDragStart as any);
        block.removeEventListener('mousedown', handleDragStart);
        block.removeEventListener('touchstart', handleDragStart as any);
        document.removeEventListener('mousemove', handleDragMove as any);
        document.removeEventListener('touchmove', handleDragMove as any);
        document.removeEventListener('mouseup', handleDragEnd as any);
        document.removeEventListener('touchend', handleDragEnd as any);
      } catch {
        // ignore
      }
    };
  }, [challenge, disableRefresh, onFail, onRefresh, onSuccess]);

  return <div ref={hostRef} className="sj-host" />;
};

export default SliderJigsawCaptcha;

