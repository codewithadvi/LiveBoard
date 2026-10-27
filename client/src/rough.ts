import type { Shape } from "@liveboard/shared";

// Hand-drawn geometry. Given a shape, produce the wobbly strokes a person
// would make with a marker: lines that bow slightly and overshoot, rectangles
// drawn as two passes, ellipses that do not quite close, hatched fills.
//
// The wobble comes from a random generator seeded by the shape's id, so the
// same shape looks the same on every screen, in every export, and every frame.
// (The shape object is replaced whenever it changes, so results are cached
// against it and only recomputed for shapes that actually changed.)

export type Pt = [number, number];

export type ClipShape =
  | { kind: "rect"; x: number; y: number; width: number; height: number; radius: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

export interface Outline {
  strokes: Pt[][]; // polylines to draw smoothed, in world coordinates
  hatch: Pt[][]; // two-point lines that fill the shape; clip to `clip` when drawing
  clip?: ClipShape; // the exact region of a rectangle or circle
}

// ---- deterministic randomness --------------------------------------------------

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function randomFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
const spread = (rnd: Rnd) => rnd() * 2 - 1; // -1 .. 1

// ---- strokes ---------------------------------------------------------------------

// One wobbly pass from a to b: scattered endpoints, a gentle bow, a little
// overshoot, and a hint of hand shake along the way. `k` is how rough it is.
function wobbleLine(a: Pt, b: Pt, k: number, rnd: Rnd): Pt[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1) return [a, b];
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  const scatter = k * Math.min(1.6, 0.4 + len / 150);
  const bow = k * spread(rnd) * Math.min(len * 0.03, 3.5);
  const over = k * rnd() * Math.min(5, len * 0.05);
  const sx = a[0] - ux * over * 0.6 + spread(rnd) * scatter;
  const sy = a[1] - uy * over * 0.6 + spread(rnd) * scatter;
  const ex = b[0] + ux * over + spread(rnd) * scatter;
  const ey = b[1] + uy * over + spread(rnd) * scatter;

  const n = Math.max(3, Math.min(22, Math.round(len / 14)));
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const bulge = Math.sin(Math.PI * t) * bow;
    const shake = i === 0 || i === n ? 0 : spread(rnd) * k * 0.35;
    pts.push([sx + (ex - sx) * t + nx * (bulge + shake), sy + (ey - sy) * t + ny * (bulge + shake)]);
  }
  return pts;
}

// Roughness 0 is exact; otherwise two passes, the second a little calmer.
function sketchLine(a: Pt, b: Pt, rough: number, rnd: Rnd): Pt[][] {
  if (rough <= 0) return [[a, b]];
  return [wobbleLine(a, b, rough, rnd), wobbleLine(a, b, rough * 0.75, rnd)];
}

// Points around a rounded rectangle, evenly spaced, starting at the top edge.
export function roundedRectPoints(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const pts: Pt[] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 10));
    for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  const arc = (cx: number, cy: number, from: number) => {
    for (let i = 0; i < 6; i++) {
      const a = from + (Math.PI / 2) * (i / 6);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  };
  edge(x + r, y, x + w - r, y);
  arc(x + w - r, y + r, -Math.PI / 2);
  edge(x + w, y + r, x + w, y + h - r);
  arc(x + w - r, y + h - r, 0);
  edge(x + w - r, y + h, x + r, y + h);
  arc(x + r, y + h - r, Math.PI / 2);
  edge(x, y + h - r, x, y + r);
  arc(x + r, y + r, Math.PI);
  return pts;
}

// A closed outline drawn like a pen: it starts somewhere, goes round, and
// finishes a little past where it began.
function sketchLoop(outline: Pt[], k: number, rnd: Rnd): Pt[][] {
  const passes: Pt[][] = [];
  for (let pass = 0; pass < 2; pass++) {
    const amp = k * (pass === 0 ? 1 : 0.75) * 1.1;
    const start = Math.floor(rnd() * outline.length);
    const loop: Pt[] = [];
    for (let i = 0; i < outline.length + 3; i++) {
      const p = outline[(start + i) % outline.length];
      loop.push([p[0] + spread(rnd) * amp, p[1] + spread(rnd) * amp]);
    }
    passes.push(loop);
  }
  return passes;
}

function sketchEllipse(cx: number, cy: number, rx: number, ry: number, k: number, rnd: Rnd): Pt[][] {
  if (k <= 0) {
    const exact: Pt[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      exact.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return [exact];
  }
  const passes: Pt[][] = [];
  const steps = Math.max(18, Math.min(64, Math.round(Math.sqrt(rx + ry) * 5)));
  for (let pass = 0; pass < 2; pass++) {
    const amp = k * (pass === 0 ? 1 : 0.8) * Math.min(2.2, 0.6 + (rx + ry) / 120);
    const start = rnd() * Math.PI * 2;
    // A smooth wobble in the radius, not noise per point.
    const f1 = 2 + Math.floor(rnd() * 2);
    const f2 = 3 + Math.floor(rnd() * 3);
    const p1 = rnd() * Math.PI * 2;
    const p2 = rnd() * Math.PI * 2;
    const overlap = 0.12 + rnd() * 0.1; // the pen keeps going a little past the start
    const pts: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = start + (i / steps) * (Math.PI * 2 + overlap);
      const wob = Math.sin(a * f1 + p1) * amp * 0.6 + Math.sin(a * f2 + p2) * amp * 0.4 + spread(rnd) * amp * 0.12;
      pts.push([cx + Math.cos(a) * (rx + wob), cy + Math.sin(a) * (ry + wob)]);
    }
    passes.push(pts);
  }
  return passes;
}

// Parallel lines at `angle` degrees covering a box, `gap` apart. The caller
// clips them to the shape.
function hatchLines(box: { x: number; y: number; width: number; height: number }, angle: number, gap: number, k: number, rnd: Rnd): Pt[][] {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const reach = Math.hypot(box.width, box.height) / 2 + 4;
  const a = (angle * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const lines: Pt[][] = [];
  const count = Math.min(400, Math.ceil((reach * 2) / gap));
  for (let i = 0; i <= count; i++) {
    const d = -reach + (i / count) * reach * 2;
    const jx = spread(rnd) * k * 1.2;
    const jy = spread(rnd) * k * 1.2;
    const bx = cx - uy * d;
    const by = cy + ux * d;
    lines.push([
      [bx - ux * reach + jx, by - uy * reach + jy],
      [bx + ux * reach - jx, by + uy * reach - jy],
    ]);
  }
  return lines;
}

// ---- whole shapes ------------------------------------------------------------------

export const hatchGap = (s: Shape) => Math.max(7, s.strokeWidth * 4 + 4);
export const cornerRadius = (s: Shape) => (s.edges === "round" ? Math.min(Math.min(s.width, s.height) * 0.18, 24) : 0);

const cache = new WeakMap<Shape, Outline>();

export function outlineOf(s: Shape): Outline {
  let out = cache.get(s);
  if (!out) {
    out = buildOutline(s);
    cache.set(s, out);
  }
  return out;
}

// How wobbly "1" is on screen. The setting is 0 to 2; this turns it into pixels.
const ROUGH_SCALE = 1.7;

function buildOutline(s: Shape): Outline {
  const rnd = randomFrom(seedOf(s.id));
  const k = s.roughness * ROUGH_SCALE;
  const out: Outline = { strokes: [], hatch: [] };

  if (s.type === "rect") {
    const { x, y, width: w, height: h } = s;
    const r = cornerRadius(s);
    out.clip = { kind: "rect", x, y, width: w, height: h, radius: r };
    if (k <= 0) {
      out.strokes.push(r > 0 ? [...roundedRectPoints(x, y, w, h, r), roundedRectPoints(x, y, w, h, r)[0]] : [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
    } else if (r > 0) {
      out.strokes.push(...sketchLoop(roundedRectPoints(x, y, w, h, r), k, rnd));
    } else {
      const tl: Pt = [x, y];
      const tr: Pt = [x + w, y];
      const br: Pt = [x + w, y + h];
      const bl: Pt = [x, y + h];
      for (const [a, b] of [[tl, tr], [tr, br], [br, bl], [bl, tl]] as [Pt, Pt][]) out.strokes.push(...sketchLine(a, b, k, rnd));
    }
    addHatch(s, { x, y, width: w, height: h }, out, rnd, k);
  } else if (s.type === "circle") {
    const rx = s.width / 2;
    const ry = s.height / 2;
    const cx = s.x + rx;
    const cy = s.y + ry;
    out.clip = { kind: "ellipse", cx, cy, rx, ry };
    out.strokes.push(...sketchEllipse(cx, cy, rx, ry, k, rnd));
    addHatch(s, { x: s.x, y: s.y, width: s.width, height: s.height }, out, rnd, k);
  } else if (s.type === "line" || s.type === "arrow") {
    const pts = (s.points ?? []).map(([px, py]) => [s.x + px, s.y + py] as Pt);
    for (let i = 0; i < pts.length - 1; i++) out.strokes.push(...sketchLine(pts[i], pts[i + 1], k, rnd));
    if (s.type === "arrow" && pts.length >= 2) {
      const [x1, y1] = pts[pts.length - 2];
      const [x2, y2] = pts[pts.length - 1];
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 10 + s.strokeWidth * 2.5;
      for (const side of [-1, 1]) {
        const a = angle + Math.PI + side * 0.5;
        out.strokes.push(...sketchLine([x2, y2], [x2 + Math.cos(a) * head, y2 + Math.sin(a) * head], k * 0.5, rnd));
      }
    }
  }
  return out;
}

function addHatch(s: Shape, box: { x: number; y: number; width: number; height: number }, out: Outline, rnd: Rnd, k: number): void {
  if (s.fill === "none" || s.fillStyle === "solid") return;
  const gap = hatchGap(s);
  out.hatch.push(...hatchLines(box, -41, gap, k, rnd));
  if (s.fillStyle === "cross") out.hatch.push(...hatchLines(box, 49, gap, k, rnd));
}

// ---- smoothing (shared by the canvas and by SVG export) ----------------------------

export interface SmoothPath {
  start: Pt;
  curves: { control: Pt; to: Pt }[];
  end?: Pt; // the final straight segment
}

// Round off a polyline: quadratic curves whose control points are the original
// vertices and whose ends are the midpoints between them.
export function smooth(pts: Pt[]): SmoothPath | undefined {
  if (pts.length < 2) return undefined;
  if (pts.length === 2) return { start: pts[0], curves: [], end: pts[1] };
  const curves: SmoothPath["curves"] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    curves.push({ control: pts[i], to: [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2] });
  }
  return { start: pts[0], curves, end: pts[pts.length - 1] };
}
