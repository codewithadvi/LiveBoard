import { getBoundingBox, type Shape, type ShapeProps } from "@liveboard/shared";

export interface Pt {
  x: number;
  y: number;
}

export function rotatePoint(p: Pt, c: Pt, angle: number): Pt {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function shapeCenter(s: Shape): Pt {
  const b = getBoundingBox(s);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// A world point expressed in the shape's own unrotated frame.
export function toLocal(s: Shape, p: Pt): Pt {
  return s.rotation === 0 ? p : rotatePoint(p, shapeCenter(s), -s.rotation);
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export type ResizeHandle = "nw" | "ne" | "se" | "sw";
export type HandleId = ResizeHandle | "rotate";

export const HANDLE_SIZE = 8; // screen pixels
export const ROTATE_OFFSET = 26; // screen pixels above the top edge

// Handle positions in world coordinates (rotated with the shape).
export function handlePositions(s: Shape, zoom: number): Record<HandleId, Pt> {
  const b = getBoundingBox(s);
  const c = shapeCenter(s);
  const raw: Record<HandleId, Pt> = {
    nw: { x: b.x, y: b.y },
    ne: { x: b.x + b.width, y: b.y },
    se: { x: b.x + b.width, y: b.y + b.height },
    sw: { x: b.x, y: b.y + b.height },
    rotate: { x: c.x, y: b.y - ROTATE_OFFSET / zoom },
  };
  const out = {} as Record<HandleId, Pt>;
  for (const id of Object.keys(raw) as HandleId[]) out[id] = rotatePoint(raw[id], c, s.rotation);
  return out;
}

export function hitHandle(s: Shape, p: Pt, zoom: number): HandleId | undefined {
  const positions = handlePositions(s, zoom);
  for (const id of Object.keys(positions) as HandleId[]) {
    if (Math.hypot(p.x - positions[id].x, p.y - positions[id].y) <= HANDLE_SIZE / zoom) return id;
  }
  return undefined;
}

const OPPOSITE: Record<ResizeHandle, ResizeHandle> = { nw: "se", ne: "sw", se: "nw", sw: "ne" };

// New geometry when `handle` is dragged to world point `p`. Always computed
// from the shape as it was when the drag began, so it never drifts. The
// opposite corner stays fixed on screen, even for a rotated shape.
export function resizeFromHandle(orig: Shape, handle: ResizeHandle, p: Pt): ShapeProps {
  const b = getBoundingBox(orig);
  const c = shapeCenter(orig);
  const corner = (id: ResizeHandle): Pt => ({
    x: id === "nw" || id === "sw" ? b.x : b.x + b.width,
    y: id === "nw" || id === "ne" ? b.y : b.y + b.height,
  });
  const anchor = corner(OPPOSITE[handle]);
  const dragged = rotatePoint(p, c, -orig.rotation);

  const width = Math.abs(dragged.x - anchor.x);
  const height = Math.abs(dragged.y - anchor.y);
  const newCenterUnrotated = { x: (anchor.x + dragged.x) / 2, y: (anchor.y + dragged.y) / 2 };
  const newCenter = rotatePoint(newCenterUnrotated, c, orig.rotation);
  const x = newCenter.x - width / 2;
  const y = newCenter.y - height / 2;

  if (!orig.points) return { x, y, width, height };

  // Point-based shapes: scale the points and make (x, y) the new box corner.
  const minX = b.x - orig.x;
  const minY = b.y - orig.y;
  const sx = b.width > 0 ? width / b.width : 1;
  const sy = b.height > 0 ? height / b.height : 1;
  return {
    x,
    y,
    points: orig.points.map(([px, py]) => [(px - minX) * sx, (py - minY) * sy] as [number, number]),
  };
}

export function rotationFromPointer(orig: Shape, p: Pt): number {
  const c = shapeCenter(orig);
  return Math.atan2(p.y - c.y, p.x - c.x) + Math.PI / 2;
}

// ---- transforming several shapes at once ------------------------------------------
//
// With more than one shape selected, one box surrounds them all and its handles
// resize or rotate the whole group: every shape is scaled about the opposite
// corner, or turned about the group's centre.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boxCenter(b: Box): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export function boxHandlePositions(b: Box, zoom: number): Record<HandleId, Pt> {
  return {
    nw: { x: b.x, y: b.y },
    ne: { x: b.x + b.width, y: b.y },
    se: { x: b.x + b.width, y: b.y + b.height },
    sw: { x: b.x, y: b.y + b.height },
    rotate: { x: b.x + b.width / 2, y: b.y - ROTATE_OFFSET / zoom },
  };
}

export function hitBoxHandle(b: Box, p: Pt, zoom: number): HandleId | undefined {
  const positions = boxHandlePositions(b, zoom);
  for (const id of Object.keys(positions) as HandleId[]) {
    if (Math.hypot(p.x - positions[id].x, p.y - positions[id].y) <= HANDLE_SIZE / zoom) return id;
  }
  return undefined;
}

const MIN_SCALE = 0.05;

// New geometry for every shape when the group's `handle` is dragged to `p`.
// `origs` are the shapes as they were when the drag began.
export function groupResize(origs: Shape[], box: Box, handle: ResizeHandle, p: Pt): Map<string, ShapeProps> {
  const corner = { x: handle === "nw" || handle === "sw" ? box.x : box.x + box.width, y: handle === "nw" || handle === "ne" ? box.y : box.y + box.height };
  const anchor = { x: box.x + box.width - (corner.x - box.x), y: box.y + box.height - (corner.y - box.y) };
  const scale = (pointer: number, from: number, grabbed: number) => {
    const span = grabbed - from;
    if (Math.abs(span) < 1e-6) return 1;
    return Math.max(MIN_SCALE, (pointer - from) / span); // cannot flip or collapse
  };
  const sx = scale(p.x, anchor.x, corner.x);
  const sy = scale(p.y, anchor.y, corner.y);

  const out = new Map<string, ShapeProps>();
  for (const s of origs) {
    const props: ShapeProps = {
      x: anchor.x + (s.x - anchor.x) * sx,
      y: anchor.y + (s.y - anchor.y) * sy,
    };
    if (s.points) props.points = s.points.map(([px, py]) => [px * sx, py * sy] as [number, number]);
    else if (s.type !== "text") {
      // (A text box is sized by its content, so it only moves.)
      props.width = s.width * sx;
      props.height = s.height * sy;
    }
    out.set(s.id, props);
  }
  return out;
}

const TAU = Math.PI * 2;
const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU;

// Turn every shape by `delta` radians about `centre`: each shape's own centre
// swings round the group's centre, and the shape also turns by `delta`.
export function groupRotate(origs: Shape[], centre: Pt, delta: number): Map<string, ShapeProps> {
  const out = new Map<string, ShapeProps>();
  for (const s of origs) {
    const c = shapeCenter(s);
    const moved = rotatePoint(c, centre, delta);
    out.set(s.id, { x: s.x + moved.x - c.x, y: s.y + moved.y - c.y, rotation: wrapAngle(s.rotation + delta) });
  }
  return out;
}
