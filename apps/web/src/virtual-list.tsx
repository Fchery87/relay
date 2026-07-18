import { useCallback, useEffect, useMemo, useRef, useState, type AriaAttributes, type ReactNode, type UIEvent } from "react";

// Rows are rarely exactly `estimateRowHeight` tall (chat messages, tool output, etc. vary a
// lot), so we track each row's real rendered height once it mounts and use that instead of the
// estimate wherever we have it. Without this, the spacer heights and the visible-window math
// drift from the actual DOM layout as soon as any row differs from the estimate, which is what
// causes virtualized lists to jump/glitch while scrolling.
export function indexAtOffset(offsets: readonly number[], target: number): number {
  const lastIndex = offsets.length - 2;
  if (lastIndex < 0) return 0;
  let low = 0;
  let high = lastIndex;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

function VirtualRow({ children, index, onMeasure }: { children: ReactNode; index: number; onMeasure: (index: number, height: number) => void }) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = rowRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height !== undefined) onMeasure(index, height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, onMeasure]);

  return <div data-virtual-row="true" ref={rowRef}>{children}</div>;
}

export function VirtualList<Item>({ ariaLive, ariaRelevant, children, className, estimateRowHeight, items, role = "list", viewportHeight = 384 }: {
  ariaLive?: "off" | "polite" | "assertive";
  ariaRelevant?: AriaAttributes["aria-relevant"];
  children: (item: Item, index: number) => ReactNode;
  className?: string;
  estimateRowHeight: number;
  items: readonly Item[];
  role?: string;
  viewportHeight?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const [heightsVersion, setHeightsVersion] = useState(0);
  const measuredHeights = useRef<Map<number, number>>(new Map());
  const overscan = 3;

  const handleMeasure = useCallback((index: number, height: number) => {
    const rounded = Math.round(height);
    if (rounded <= 0 || measuredHeights.current.get(index) === rounded) return;
    measuredHeights.current.set(index, rounded);
    setHeightsVersion((version) => version + 1);
  }, []);

  const offsets = useMemo(() => {
    const result: number[] = [0];
    for (let index = 0; index < items.length; index += 1) result.push(result[index]! + (measuredHeights.current.get(index) ?? estimateRowHeight));
    return result;
    // heightsVersion invalidates this memo when a real measurement replaces an estimate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, estimateRowHeight, heightsVersion]);

  const totalHeight = offsets[items.length] ?? 0;
  const start = Math.max(0, indexAtOffset(offsets, scrollTop) - overscan);
  const end = Math.min(items.length, indexAtOffset(offsets, scrollTop + viewportHeight) + 1 + overscan);
  const visibleItems = items.slice(start, end);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return <div aria-live={ariaLive} aria-relevant={ariaRelevant} className={className} data-virtual-list="true" onScroll={handleScroll} role={role} style={{ height: viewportHeight, overflowY: "auto" }}>
    <div aria-hidden="true" style={{ height: offsets[start] }} />
    {visibleItems.map((item, offset) => <VirtualRow index={start + offset} key={start + offset} onMeasure={handleMeasure}>{children(item, start + offset)}</VirtualRow>)}
    <div aria-hidden="true" style={{ height: totalHeight - (offsets[end] ?? totalHeight) }} />
  </div>;
}
