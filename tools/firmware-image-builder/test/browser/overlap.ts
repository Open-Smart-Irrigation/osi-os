import type { Locator } from '@playwright/test';

export interface ElementOverlap {
  readonly first: number;
  readonly second: number;
  readonly horizontalPixels: number;
  readonly verticalPixels: number;
}

export async function pairwiseOverlaps(locator: Locator, tolerancePixels = 0.5): Promise<readonly ElementOverlap[]> {
  const boxes = await locator.evaluateAll((elements) => elements
    .filter((element) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
    })
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }));
  const overlaps: ElementOverlap[] = [];
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const left = boxes[first]!;
      const right = boxes[second]!;
      const horizontalPixels = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const verticalPixels = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (horizontalPixels > tolerancePixels && verticalPixels > tolerancePixels) {
        overlaps.push({ first, second, horizontalPixels, verticalPixels });
      }
    }
  }
  return overlaps;
}
