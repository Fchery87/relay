import { useState, type AriaAttributes, type ReactNode, type UIEvent } from "react";

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
  const overscan = 3;
  const start = Math.max(0, Math.floor(scrollTop / estimateRowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / estimateRowHeight) + overscan);
  const visibleItems = items.slice(start, end);

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    setScrollTop(event.currentTarget.scrollTop);
  }

  return <div aria-live={ariaLive} aria-relevant={ariaRelevant} className={className} data-virtual-list="true" onScroll={handleScroll} role={role} style={{ height: viewportHeight, overflowY: "auto" }}>
    <div aria-hidden="true" style={{ height: start * estimateRowHeight }} />
    {visibleItems.map((item, offset) => <div data-virtual-row="true" key={start + offset} style={{ minHeight: estimateRowHeight }}>{children(item, start + offset)}</div>)}
    <div aria-hidden="true" style={{ height: (items.length - end) * estimateRowHeight }} />
  </div>;
}
