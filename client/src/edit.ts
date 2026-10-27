import { getBoundingBox, type Point, type Shape } from "@liveboard/shared";

// Pure helpers for the editing features. None of them touch the DOM or the
// network, so they can be tested directly.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeRect(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

// The smallest upright rectangle around a shape after its rotation is applied.
export function rotatedBounds(s: Shape): Rect {
  const b = getBoundingBox(s);
  if (s.rotation === 0) return b;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const cos = Math.cos(s.rotation);
  const sin = Math.sin(s.rotation);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]]) {
    xs.push(cx + (px - cx) * cos - (py - cy) * sin);
    ys.push(cy + (px - cx) * sin + (py - cy) * cos);
  }
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Shapes touched by a rubber-band rectangle (by their true on-screen outline,
// so a thin rotated bar is not selected by a box that is nowhere near it).
export function shapesInRect(shapes: Shape[], rect: Rect): Shape[] {
  return shapes.filter((s) => {
    const b = rotatedBounds(s);
    const pad = s.strokeWidth;
    return (
      b.x + b.width + pad >= rect.x &&
      b.x - pad <= rect.x + rect.width &&
      b.y + b.height + pad >= rect.y &&
      b.y - pad <= rect.y + rect.height
    );
  });
}

// ---- copy / paste ----------------------------------------------------------

export interface PastedShape {
  shape: Shape;
  text?: string; // text content is added separately, through OT
}

// Fresh copies with new ids, shifted by (dx, dy) and stacked above `topZ`
// in their original relative order.
export function cloneShapes(shapes: Shape[], dx: number, dy: number, topZ: number, newId: () => string): PastedShape[] {
  const ordered = [...shapes].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));
  return ordered.map((s, i) => {
    const copy = structuredClone(s);
    const text = copy.text;
    delete copy.text;
    return { shape: { ...copy, id: newId(), x: s.x + dx, y: s.y + dy, zIndex: topZ + i + 1 }, text };
  });
}

// ---- layer order -------------------------------------------------------------

export type ReorderMode = "front" | "back" | "forward" | "backward";

// New zIndex values (only for shapes that must change) to move the selection in
// the stack. Stacking is by zIndex, then id. Values are chosen between
// neighbours rather than renumbering the whole board, so one reorder touches
// only the selected shapes and cannot fight other people's edits.
export function reorderZ(all: Shape[], selectedIds: Set<string>, mode: ReorderMode): Map<string, number> {
  const sorted = [...all].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));
  const selected = sorted.filter((s) => selectedIds.has(s.id));
  const result = new Map<string, number>();
  if (selected.length === 0) return result;
  const others = sorted.filter((s) => !selectedIds.has(s.id));
  const n = selected.length;

  const spread = (from: number, to: number) =>
    selected.forEach((s, i) => result.set(s.id, from + ((to - from) * (i + 1)) / (n + 1)));

  if (mode === "front") {
    const top = others.length ? others[others.length - 1].zIndex : selected[0].zIndex;
    selected.forEach((s, i) => result.set(s.id, top + i + 1));
  } else if (mode === "back") {
    const bottom = others.length ? others[0].zIndex : selected[0].zIndex;
    selected.forEach((s, i) => result.set(s.id, bottom - n + i));
  } else if (mode === "forward") {
    const lastSel = sorted.lastIndexOf(selected[n - 1]);
    const next = sorted.slice(lastSel + 1).find((s) => !selectedIds.has(s.id));
    if (!next) return result;
    const after = sorted.slice(sorted.indexOf(next) + 1).find((s) => !selectedIds.has(s.id) && s.zIndex > next.zIndex);
    spread(next.zIndex, after ? after.zIndex : next.zIndex + 1);
  } else {
    const firstSel = sorted.indexOf(selected[0]);
    const prev = [...sorted.slice(0, firstSel)].reverse().find((s) => !selectedIds.has(s.id));
    if (!prev) return result;
    const before = [...sorted.slice(0, sorted.indexOf(prev))].reverse().find((s) => !selectedIds.has(s.id) && s.zIndex < prev.zIndex);
    spread(before ? before.zIndex : prev.zIndex - 1, prev.zIndex);
  }
  // Keep only real changes.
  for (const s of selected) if (result.get(s.id) === s.zIndex) result.delete(s.id);
  return result;
}

// ---- erasing part of a stroke ---------------------------------------------------

export interface ErasedPath {
  // Runs of points that survive, each at least two points long.
  pieces: Point[][];
  removedAny: boolean;
}

// Cut out the part of a freehand stroke within `radius` of (wx, wy) (world
// coordinates). The remaining runs become separate strokes. If the pointer
// touched the line between two samples without being near either, the
// nearest sample is removed so the eraser always bites.
export function erasePath(shape: Shape, wx: number, wy: number, radius: number): ErasedPath {
  const pts = shape.points ?? [];
  const dist = (p: Point) => Math.hypot(shape.x + p[0] - wx, shape.y + p[1] - wy);
  let remove = pts.map((p) => dist(p) <= radius);
  if (!remove.some(Boolean) && pts.length > 0) {
    let nearest = 0;
    pts.forEach((p, i) => {
      if (dist(p) < dist(pts[nearest])) nearest = i;
    });
    remove = remove.map((_, i) => i === nearest);
  }
  const pieces: Point[][] = [];
  let run: Point[] = [];
  pts.forEach((p, i) => {
    if (remove[i]) {
      if (run.length >= 2) pieces.push(run);
      run = [];
    } else run.push(p);
  });
  if (run.length >= 2) pieces.push(run);
  return { pieces, removedAny: remove.some(Boolean) };
}

// One rectangle around several shapes (their true rotated outlines).
export function unionBounds(shapes: Shape[]): Rect {
  const boxes = shapes.map(rotatedBounds);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}
