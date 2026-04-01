import type { BoundingBox, Mask } from '../../types';
import { ANNOTATION_COLOR_PALETTE, SAM2_OBJECT_LABEL, SAM2_OBJECT_RESERVED_COLOR } from './annotationColors';

type AssignInput = { masks: Mask[]; boundingBoxes: BoundingBox[] };

export const assignMissingColorsForAnnotations = (
  input: AssignInput,
  labelColorMap: Map<string, string>,
): AssignInput => {
  const getNextPaletteColor = (excludedColors: Set<string>) => {
    let maxUsedIndex = -1;
    for (let i = 0; i < ANNOTATION_COLOR_PALETTE.length; i += 1) {
      const c = ANNOTATION_COLOR_PALETTE[i];
      if (excludedColors.has(c) && i > maxUsedIndex) {
        maxUsedIndex = i;
      }
    }
    const nextIndex = maxUsedIndex + 1;
    if (nextIndex >= ANNOTATION_COLOR_PALETTE.length) {
      return ANNOTATION_COLOR_PALETTE[ANNOTATION_COLOR_PALETTE.length - 1];
    }
    return ANNOTATION_COLOR_PALETTE[nextIndex];
  };

  const getColorForLabel = (label: string | undefined, fallbackIndex: number): string => {
    const normalizedLabel = String(label || '').trim();
    if (normalizedLabel.toLowerCase() === SAM2_OBJECT_LABEL) {
      return SAM2_OBJECT_RESERVED_COLOR;
    }

    const key = normalizedLabel.length > 0 ? normalizedLabel : `__unnamed_${fallbackIndex}`;
    const existing = labelColorMap.get(key);
    if (existing && existing !== SAM2_OBJECT_RESERVED_COLOR) {
      return existing;
    }

    const usedColors = new Set<string>(Array.from(labelColorMap.values()));
    usedColors.add(SAM2_OBJECT_RESERVED_COLOR);
    const color = getNextPaletteColor(usedColors);
    labelColorMap.set(key, color);
    return color;
  };

  const coloredMasks: Mask[] = input.masks.map((mask, index) => ({
    ...mask,
    color: mask.color || getColorForLabel(mask.label, index),
  }));

  const coloredBBoxes: BoundingBox[] = input.boundingBoxes.map((bbox, index) => ({
    ...bbox,
    color: bbox.color || getColorForLabel(bbox.label, input.masks.length + index),
  }));

  return { masks: coloredMasks, boundingBoxes: coloredBBoxes };
};

export const buildLabelColorMapFromSources = (params: {
  projectLabelMappings?: Array<{ label?: string; labelZh?: string; color?: string }>;
  masks?: Mask[];
  boundingBoxes?: BoundingBox[];
}): Map<string, string> => {
  const map = new Map<string, string>();

  (params.projectLabelMappings || []).forEach((item) => {
    const label = String(item?.label || '').trim();
    const color = String(item?.color || '').trim();
    if (!label || !color) return;
    if (!map.has(label)) map.set(label, color);
  });

  (params.masks || []).forEach((mask) => {
    const label = String(mask?.label || '').trim();
    const color = String(mask?.color || '').trim();
    if (!label || !color) return;
    if (!map.has(label)) map.set(label, color);
  });

  (params.boundingBoxes || []).forEach((bbox) => {
    const label = String(bbox?.label || '').trim();
    const color = String(bbox?.color || '').trim();
    if (!label || !color) return;
    if (!map.has(label)) map.set(label, color);
  });

  return map;
};

export const resolveColorForLabelEdit = (params: {
  newLabel: string;
  currentLabel?: string;
  fallbackColor?: string;
  labelColorMap: Map<string, string>;
  palette: string[];
}): string | undefined => {
  const { newLabel, currentLabel, fallbackColor, labelColorMap, palette } = params;
  const trimmed = String(newLabel || '').trim();

  if (trimmed.length > 0) {
    if (labelColorMap.has(trimmed)) {
      return labelColorMap.get(trimmed)!;
    }

    const usedColors = new Set(labelColorMap.values());
    const assigned = palette.find((c) => !usedColors.has(c));
    const picked = assigned || palette[usedColors.size % palette.length];
    labelColorMap.set(trimmed, picked);
    return picked;
  }

  const firstLabel = String(currentLabel || '').trim();
  if (firstLabel && labelColorMap.has(firstLabel)) {
    return labelColorMap.get(firstLabel)!;
  }
  return fallbackColor || palette[0];
};

