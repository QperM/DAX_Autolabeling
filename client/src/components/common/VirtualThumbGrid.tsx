import React, { useEffect, useMemo, useRef, useState } from 'react';

type RenderTileParams<T> = {
  item: T;
  isSelected: boolean;
  style: React.CSSProperties;
};

export type VirtualThumbGridProps<T> = {
  items: T[];
  getId: (item: T) => string | number;
  selectedId?: string | number | null;
  thumbSize: number;
  thumbGap: number;
  onSelect?: (item: T) => void;
  onTileMouseEnter?: (item: T) => void;
  onVisibleItemsChange?: (visibleItems: T[]) => void;
  getTileClassName?: (item: T, isSelected: boolean) => string;
  renderTile: (params: RenderTileParams<T>) => React.ReactNode;
};

/**
 * 通用“虚拟滚动缩略图网格”：只渲染当前视口附近的 tile。
 * 样式复用全局 shared 类名（`AnnotationPageShared.css`）：
 * - `.thumbnails-grid` / `.thumbnails-virtual-scroll` / `.thumbnails-virtual-measure` / `.thumbnails-virtual-inner`
 */
export default function VirtualThumbGrid<T>(props: VirtualThumbGridProps<T>) {
  const {
    items,
    getId,
    selectedId = null,
    thumbSize,
    thumbGap,
    onSelect,
    onTileMouseEnter,
    onVisibleItemsChange,
    getTileClassName,
    renderTile,
  } = props;

  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const measureElRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [thumbViewport, setThumbViewport] = useState({ width: 0, height: 0 });
  const [thumbScrollTop, setThumbScrollTop] = useState(0);

  const thumbStride = thumbSize + thumbGap;

  useEffect(() => {
    const scrollEl = scrollElRef.current;
    const measureEl = measureElRef.current;
    if (!scrollEl || !measureEl) return;

    const updateViewport = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const cs = window.getComputedStyle(measureEl);
        const padLeft = parseFloat(cs.paddingLeft || '0') || 0;
        const padRight = parseFloat(cs.paddingRight || '0') || 0;

        const contentW = Math.max(0, Math.round(scrollEl.clientWidth - padLeft - padRight));
        const contentH = Math.max(0, Math.round(scrollEl.clientHeight));
        setThumbViewport((prev) => (prev.width === contentW && prev.height === contentH ? prev : { width: contentW, height: contentH }));
        setThumbScrollTop(scrollEl.scrollTop || 0);
      });
    };

    updateViewport();

    const ro = new ResizeObserver(() => updateViewport());
    ro.observe(scrollEl);
    ro.observe(measureEl);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [items.length, thumbSize, thumbGap]);

  const thumbCols = useMemo(() => {
    const w = thumbViewport.width;
    if (!w) return 1;
    return Math.max(1, Math.floor((w + thumbGap) / thumbStride));
  }, [thumbViewport.width, thumbGap, thumbStride]);

  const thumbTotalRows = useMemo(() => {
    if (items.length === 0) return 0;
    return Math.ceil(items.length / thumbCols);
  }, [items.length, thumbCols]);

  const thumbTotalHeight = useMemo(() => {
    if (items.length === 0) return 0;
    if (thumbTotalRows === 0) return 0;
    return Math.max(0, thumbTotalRows * thumbSize + Math.max(0, thumbTotalRows - 1) * thumbGap);
  }, [items.length, thumbTotalRows, thumbSize, thumbGap]);

  const virtualThumbRange = useMemo(() => {
    if (thumbTotalRows === 0) return { startIndex: 0, endIndex: 0 };
    const viewH = thumbViewport.height || 0;
    const overscanRows = 2;
    const rowHeight = thumbStride;
    const startRow = Math.max(0, Math.floor((thumbScrollTop - overscanRows * rowHeight) / rowHeight));
    const endRow = Math.min(
      Math.max(0, thumbTotalRows - 1),
      Math.ceil((thumbScrollTop + viewH + overscanRows * rowHeight) / rowHeight)
    );

    const startIndex = startRow * thumbCols;
    const endIndex = Math.min(items.length, (endRow + 1) * thumbCols);
    return { startIndex, endIndex };
  }, [thumbTotalRows, thumbViewport.height, thumbScrollTop, thumbStride, thumbCols, items.length]);

  const visibleItems = useMemo(() => {
    return items.slice(virtualThumbRange.startIndex, virtualThumbRange.endIndex);
  }, [items, virtualThumbRange.startIndex, virtualThumbRange.endIndex]);

  useEffect(() => {
    onVisibleItemsChange?.(visibleItems);
  }, [onVisibleItemsChange, visibleItems]);

  return (
    <div
      className="thumbnails-grid thumbnails-virtual-scroll"
      ref={scrollElRef}
      onScroll={(e) => {
        const top = (e.currentTarget as HTMLDivElement).scrollTop;
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => setThumbScrollTop(top));
      }}
    >
      <div
        className="thumbnails-virtual-measure"
        ref={(el) => {
          measureElRef.current = el;
        }}
      >
        <div className="thumbnails-virtual-inner" style={{ height: thumbTotalHeight }}>
          {visibleItems.map((item, i) => {
            const absoluteIndex = virtualThumbRange.startIndex + i;
            const row = Math.floor(absoluteIndex / thumbCols);
            const col = absoluteIndex % thumbCols;
            const top = row * thumbStride;
            const left = col * thumbStride;
            const isSelected = selectedId != null && getId(item) === selectedId;
            const extraClassName = getTileClassName ? getTileClassName(item, isSelected) : '';
            return (
              <div
                key={String(getId(item))}
                className={`thumbnail-item-small ${isSelected ? 'selected' : ''} ${extraClassName}`.trim()}
                style={{ position: 'absolute', width: thumbSize, height: thumbSize, top, left }}
                onClick={() => onSelect?.(item)}
                onMouseEnter={() => onTileMouseEnter?.(item)}
              >
                {renderTile({ item, isSelected, style: { width: thumbSize, height: thumbSize } })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

