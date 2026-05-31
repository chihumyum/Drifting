import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react';

/**
 * 让 textarea 随内容自动增高，避免固定 rows 把长文本裁切掉。
 *
 * 用法：
 *   const ref = useAutosizeTextArea(value);
 *   <textarea ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
 *
 * - 挂载时、`value` 变化时（含外部赋值）都会重新测量。
 * - 容器宽度变化时也会重新测量，避免自动换行后高度过期。
 */
export function useAutosizeTextArea(
  value: string | null | undefined,
): RefCallback<HTMLTextAreaElement> {
  const elementRef = useRef<HTMLTextAreaElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const resize = useCallback(() => {
    const el = elementRef.current;
    if (!el) return;
    // 先收回到 auto 再读 scrollHeight，否则高度只增不减
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [resize, value]);

  const setRef = useCallback<RefCallback<HTMLTextAreaElement>>((el) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    elementRef.current = el;
    if (!el) return;

    resize();
    if (typeof ResizeObserver === 'undefined') return;
    let previousWidth = el.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width;
      if (width === undefined || width === previousWidth) return;
      previousWidth = width;
      resize();
    });
    observer.observe(el);
    observerRef.current = observer;
  }, [resize]);

  useLayoutEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  return setRef;
}
