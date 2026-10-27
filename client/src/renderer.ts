import { getBoundingBox, type BoundingBox, type Shape } from "@liveboard/shared";
import type { Board } from "./board";
import { drawShape } from "./drawing";
import { unionBounds } from "./edit";
import { boxHandlePositions, handlePositions, HANDLE_SIZE, shapeCenter } from "./geometry";

export interface View {
  panX: number;
  panY: number;
  zoom: number;
}

export interface RemoteCursor {
  x: number;
  y: number;
  name: string;
  color: string;
  seen: number;
}

interface LaserTrail {
  color: string;
  points: { x: number; y: number; t: number }[];
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 5;
export const GRID = 24; // world units between grid dots (also what "snap" snaps to)
const CURSOR_FADE_MS = 6000;
const LASER_LIFE_MS = 900;
const FALLBACK_ACCENT = "#6d5bd0";

// Shapes live in world coordinates; the mouse reports screen coordinates.
export function screenToWorld(sx: number, sy: number, view: View) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Draws whatever is on the board, the selection, and other people's cursors.
// It has no per-tool or per-feature logic.
export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  view: View = { panX: 0, panY: 0, zoom: 1 };
  // Shapes the user has selected. Resize/rotate handles show only for exactly one.
  selection = new Set<string>();
  // The rubber-band rectangle while dragging on empty space (world coordinates).
  marquee: { x: number; y: number; width: number; height: number } | null = null;
  cursors = new Map<string, RemoteCursor>();
  lasers = new Map<string, LaserTrail>();
  showGrid = true;
  // Screen pixels per CSS pixel, so lines stay sharp on high-resolution displays.
  dpr = 1;
  // The UI colour for selections: the colour other people see as yours.
  accent = FALLBACK_ACCENT;
  // A shape object is replaced whenever it changes, so its bounds can be cached against it.
  private bounds = new WeakMap<Shape, BoundingBox>();

  constructor(private canvas: HTMLCanvasElement, private board: Board) {
    this.ctx = canvas.getContext("2d")!;
  }

  start(): void {
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  addLaserPoint(id: string, x: number, y: number, color: string): void {
    let trail = this.lasers.get(id);
    if (!trail) this.lasers.set(id, (trail = { color, points: [] }));
    trail.color = color;
    trail.points.push({ x, y, t: performance.now() });
  }

  private render(): void {
    const { ctx, canvas, view, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.zoom * dpr, 0, 0, view.zoom * dpr, view.panX * dpr, view.panY * dpr);

    const left = -view.panX / view.zoom;
    const top = -view.panY / view.zoom;
    const right = left + canvas.width / dpr / view.zoom;
    const bottom = top + canvas.height / dpr / view.zoom;
    if (this.showGrid) this.renderGrid(left, top, right, bottom);

    // Only draw what can be seen: with thousands of shapes, most are off-screen.
    for (const shape of this.board.list()) {
      const box = this.visibleBox(shape, left, top, right, bottom);
      if (!box) continue;
      // Zoomed far out a shape is only a few pixels across: a plain block looks
      // the same and costs far less than tracing its outline.
      const onScreen = Math.max(box.width, box.height) * view.zoom;
      if (onScreen < 12) {
        ctx.fillStyle = shape.fill !== "none" ? shape.fill : shape.stroke;
        const minSide = 2 / view.zoom;
        ctx.fillRect(box.x, box.y, Math.max(box.width, minSide), Math.max(box.height, minSide));
      } else {
        drawShape(ctx, shape);
      }
    }

    const selected = [...this.selection].map((id) => this.board.get(id)).filter((s): s is Shape => !!s);
    for (const s of selected) this.renderSelection(s, selected.length === 1);
    if (selected.length > 1) this.renderGroup(selected);
    if (this.marquee) {
      const m = this.marquee;
      ctx.save();
      ctx.fillStyle = withAlpha(this.accent, 0.1);
      ctx.strokeStyle = this.accent;
      ctx.lineWidth = 1 / view.zoom;
      ctx.fillRect(m.x, m.y, m.width, m.height);
      ctx.strokeRect(m.x, m.y, m.width, m.height);
      ctx.restore();
    }
    this.renderLasers();
    this.renderCursors();
  }

  // Dots, drawn as one path so even a big view is a single fill.
  private renderGrid(left: number, top: number, right: number, bottom: number): void {
    const { ctx, view } = this;
    if (view.zoom < 0.45) return; // too fine to be useful: it would just be noise
    const size = Math.max(1.4, 1.6 / view.zoom);
    ctx.fillStyle = "#c6cedc";
    ctx.beginPath();
    for (let x = Math.floor(left / GRID) * GRID; x <= right; x += GRID) {
      for (let y = Math.floor(top / GRID) * GRID; y <= bottom; y += GRID) ctx.rect(x - size / 2, y - size / 2, size, size);
    }
    ctx.fill();
  }

  // The shape's bounds if any part of it can be seen, otherwise undefined.
  private visibleBox(s: Shape, left: number, top: number, right: number, bottom: number): BoundingBox | undefined {
    let box = this.bounds.get(s);
    if (!box) {
      box = getBoundingBox(s);
      this.bounds.set(s, box);
    }
    // Rotation can swing the corners out, so test the circle around the centre.
    const pad = s.strokeWidth + s.roughness * 4 + (s.rotation !== 0 ? Math.hypot(box.width, box.height) / 2 : 0);
    const inView =
      box.x + box.width + pad >= left &&
      box.x - pad <= right &&
      box.y + box.height + pad >= top &&
      box.y - pad <= bottom;
    return inView ? box : undefined;
  }

  private drawHandles(handles: ReturnType<typeof boxHandlePositions>, stemFrom: { x: number; y: number }): void {
    const { ctx } = this;
    const zoom = this.view.zoom;
    const half = HANDLE_SIZE / zoom / 2;
    ctx.save();
    ctx.strokeStyle = this.accent;
    ctx.fillStyle = "#fff";
    ctx.lineWidth = 1.4 / zoom;
    ctx.beginPath();
    ctx.moveTo(stemFrom.x, stemFrom.y);
    ctx.lineTo(handles.rotate.x, handles.rotate.y);
    ctx.stroke();
    for (const id of ["nw", "ne", "se", "sw"] as const) {
      ctx.beginPath();
      ctx.roundRect(handles[id].x - half, handles[id].y - half, half * 2, half * 2, 2 / zoom);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(handles.rotate.x, handles.rotate.y, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Several shapes selected: one box around all of them, with handles that
  // resize or rotate the whole group.
  private renderGroup(shapes: Shape[]): void {
    const { ctx } = this;
    const zoom = this.view.zoom;
    const box = unionBounds(shapes);
    ctx.save();
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1.4 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeRect(box.x, box.y, box.width, box.height);
    ctx.restore();
    this.drawHandles(boxHandlePositions(box, zoom), { x: box.x + box.width / 2, y: box.y });
  }

  private renderSelection(s: Shape, withHandles: boolean): void {
    const { ctx } = this;
    const zoom = this.view.zoom;
    const box = getBoundingBox(s);
    ctx.save();
    if (s.rotation !== 0) {
      const c = shapeCenter(s);
      ctx.translate(c.x, c.y);
      ctx.rotate(s.rotation);
      ctx.translate(-c.x, -c.y);
    }
    ctx.strokeStyle = withAlpha(this.accent, withHandles ? 0.9 : 0.6);
    ctx.lineWidth = 1.4 / zoom;
    ctx.setLineDash(withHandles ? [] : [5 / zoom, 4 / zoom]);
    const pad = 4 / zoom;
    ctx.beginPath();
    ctx.roundRect(box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2, 3 / zoom);
    ctx.stroke();
    ctx.restore();
    if (!withHandles) return; // several shapes selected: outline only

    // Handles are drawn unrotated at their rotated world positions so they
    // stay the same size and shape on screen.
    const handles = handlePositions(s, zoom);
    this.drawHandles(handles, { x: (handles.nw.x + handles.ne.x) / 2, y: (handles.nw.y + handles.ne.y) / 2 });
  }

  // A fading glow that follows a laser pointer.
  private renderLasers(): void {
    const { ctx, view } = this;
    const now = performance.now();
    for (const [id, trail] of this.lasers) {
      trail.points = trail.points.filter((p) => now - p.t < LASER_LIFE_MS);
      if (trail.points.length === 0) {
        this.lasers.delete(id);
        continue;
      }
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 1; i < trail.points.length; i++) {
        const a = trail.points[i - 1];
        const b = trail.points[i];
        const life = 1 - (now - b.t) / LASER_LIFE_MS;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = withAlpha(trail.color, 0.22 * life);
        ctx.lineWidth = 12 / view.zoom;
        ctx.stroke();
        ctx.strokeStyle = withAlpha(trail.color, 0.95 * life);
        ctx.lineWidth = 3.5 / view.zoom;
        ctx.stroke();
      }
      const head = trail.points[trail.points.length - 1];
      ctx.beginPath();
      ctx.arc(head.x, head.y, 5 / view.zoom, 0, Math.PI * 2);
      ctx.fillStyle = trail.color;
      ctx.fill();
      ctx.restore();
    }
  }

  // Other users' pointers: an arrow plus a name tag, at constant screen size.
  private renderCursors(): void {
    const { ctx, view } = this;
    const now = performance.now();
    for (const [id, c] of this.cursors) {
      if (now - c.seen > CURSOR_FADE_MS) {
        this.cursors.delete(id);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.min(1, (CURSOR_FADE_MS - (now - c.seen)) / 1500);
      ctx.translate(c.x, c.y);
      ctx.scale(1 / view.zoom, 1 / view.zoom);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 17);
      ctx.lineTo(4.5, 13);
      ctx.lineTo(8, 20);
      ctx.lineTo(11, 18.5);
      ctx.lineTo(7.5, 12);
      ctx.lineTo(13, 12);
      ctx.closePath();
      ctx.fillStyle = c.color;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fill();
      ctx.font = '600 12px "Bricolage Grotesque Variable", system-ui, sans-serif';
      ctx.textBaseline = "middle";
      const w = ctx.measureText(c.name).width;
      ctx.beginPath();
      ctx.roundRect(14, 17, w + 12, 20, 10);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillText(c.name, 20, 27.5);
      ctx.restore();
    }
  }
}
