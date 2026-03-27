/**
 * Windows Explorer 风格的“自然顺序”排序（numeric sort）。
 *
 * 目标：
 * - 不只看文件名末尾的数字，而是基于“整个文件名”逐段比较。
 * - 兼容类似 rgb_head_0.png / rgb_img12.png / 仅 2D 的文件名等非标准命名。
 */

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base', // 忽略大小写差异
});

const normalize = (s: unknown) => String(s ?? '').replace(/\\/g, '/').trim();

export const compareWindowsFilename = (a: unknown, b: unknown): number => {
  const sa = normalize(a);
  const sb = normalize(b);
  return collator.compare(sa, sb);
};

export const sortByWindowsFilename = <T,>(items: T[], getName: (item: T) => unknown): T[] => {
  // 稳定性：在 compare 相等时回退到原始顺序（现代 V8 sort 稳定，但这里再兜底）
  return items
    .map((item, idx) => ({ item, idx }))
    .slice()
    .sort((x, y) => {
      const c = compareWindowsFilename(getName(x.item), getName(y.item));
      return c !== 0 ? c : x.idx - y.idx;
    })
    .map((x) => x.item);
};

