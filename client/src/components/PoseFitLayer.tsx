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
  if (!enabled || !overlayUrl || !imageDisplayRect || imageDisplayRect.width <= 0 || imageDisplayRect.height <= 0) {
    return null;
  }

  return (
    <img
      src={overlayUrl}
      alt="Diff-DOPE 拟合效果"
      style={{
        position: 'absolute',
        left: imageDisplayRect.left,
        top: imageDisplayRect.top,
        width: imageDisplayRect.width,
        height: imageDisplayRect.height,
        objectFit: 'fill',
        opacity,
        pointerEvents: 'none',
        zIndex: 30,
      }}
    />
  );
};

export default PoseFitLayer;
