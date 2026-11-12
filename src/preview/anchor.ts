// Keeps the reading position on the same content across re-renders.

export interface BlockBox {
  key: string;
  line: number;
  top: number;
  height: number;
}

export interface Anchor {
  key: string;
  index: number;
  line: number;
  offset: number;
  /** Keys of the blocks after the anchor, used if the anchor is deleted. */
  following: string[];
}

/** The block at the top edge of the viewport and how far into it we are. */
export function captureAnchor(boxes: BlockBox[], viewportTop: number): Anchor | null {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i] as BlockBox;
    if (b.top + b.height > viewportTop) {
      return {
        key: b.key,
        index: i,
        line: b.line,
        offset: Math.max(0, viewportTop - b.top),
        following: boxes.slice(i + 1, i + 4).map((x) => x.key),
      };
    }
  }
  return null;
}

function nearest(boxes: BlockBox[], key: string, index: number): number {
  let best = -1;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i]?.key !== key) continue;
    if (best < 0 || Math.abs(i - index) < Math.abs(best - index)) best = i;
  }
  return best;
}

/** Scroll offset that shows the anchored content at the viewport top. */
export function resolveAnchor(anchor: Anchor, boxes: BlockBox[]): number {
  const same = nearest(boxes, anchor.key, anchor.index);
  if (same >= 0) {
    const b = boxes[same] as BlockBox;
    return b.top + Math.min(anchor.offset, b.height);
  }
  for (const key of anchor.following) {
    const i = nearest(boxes, key, anchor.index);
    if (i >= 0) return (boxes[i] as BlockBox).top;
  }
  // Nothing recognizable: the block covering the old source line, else the
  // last block that starts before it.
  let candidate: BlockBox | undefined;
  for (const b of boxes) {
    if (b.line <= anchor.line) candidate = b;
    else break;
  }
  return candidate ? candidate.top : 0;
}
