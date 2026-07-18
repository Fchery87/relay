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
