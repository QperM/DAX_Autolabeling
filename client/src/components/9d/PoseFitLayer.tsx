import React from 'react';

type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Props = {
  enabled: boolean;
  overlayUrl: string | null;
  imageDisplayRect: Rect | null;
  opacity?: number;
};

const PoseFitLayer: React.FC<Props> = ({ enabled, overlayUrl, imageDisplayRect, opacity = 0.92 }) => {
  if (!enabled || !overlayUrl) {
    return null;
  }

  const hasRect = !!imageDisplayRect && imageDisplayRect.width > 0 && imageDisplayRect.height > 0;

  return (
    <img
      src={overlayUrl}
      alt="Diff-DOPE 拟合效果"
      style={{
        position: 'absolute',
        // imageDisplayRect 依赖 RGB 图层的渲染尺寸。
        // 切换拟合图层时如果 imageDisplayRect 还没算出来，就用整块容器做兜底，避免白屏。
        left: hasRect ? imageDisplayRect!.left : 0,
        top: hasRect ? imageDisplayRect!.top : 0,
        width: hasRect ? imageDisplayRect!.width : '100%',
        height: hasRect ? imageDisplayRect!.height : '100%',
        // 有 imageDisplayRect 时，overlay 应严格铺到 RGB 的实际绘制区域；
        // 没有 rect（兜底）时，用 contain 防止拉伸比例错位。
        objectFit: hasRect ? 'fill' : 'contain',
        opacity,
        pointerEvents: 'none',
        zIndex: 20,
      }}
    />
  );
};

export default PoseFitLayer;
