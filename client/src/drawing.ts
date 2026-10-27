import { getBoundingBox, type FontFamily, type Shape, type StrokeStyle } from "@liveboard/shared";
import { catmullRomSegments } from "./curve";
import { outlineOf, smooth, type ClipShape, type Pt } from "./rough";

// CSS font stacks. The hand-written face and the UI face are bundled with the
// app; the rest are fallbacks for when they have not loaded yet.
export const FONT_STACKS: Record<FontFamily, string> = {
  hand: '"Caveat", "Segoe Print", "Bradley Hand", cursive',
  sans: '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace',
};

export const fontCss = (s: Pick<Shape, "fontFamily" | "fontSize">) => `${s.fontSize}px ${FONT_STACKS[s.fontFamily]}`;
export const lineHeightOf = (s: Pick<Shape, "fontSize">) => Math.round(s.fontSize * 1.3);

export function dashFor(style: StrokeStyle, width: number): number[] {
  if (style === "dashed") return [width * 4 + 5, width * 2 + 5];
  if (style === "dotted") return [0.1, width * 2 + 5]; // round caps turn these into dots
  return [];
}

export function clipPath(ctx: CanvasRenderingContext2D, clip: ClipShape): void {
  ctx.beginPath();
  if (clip.kind === "rect") {
    if (clip.radius > 0) ctx.roundRect(clip.x, clip.y, clip.width, clip.height, clip.radius);
    else ctx.rect(clip.x, clip.y, clip.width, clip.height);
  } else {
    ctx.ellipse(clip.cx, clip.cy, Math.max(clip.rx, 0), Math.max(clip.ry, 0), 0, 0, Math.PI * 2);
  }
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  const path = smooth(pts);
  if (!path) return;
  ctx.beginPath();
  ctx.moveTo(path.start[0], path.start[1]);
  for (const c of path.curves) ctx.quadraticCurveTo(c.control[0], c.control[1], c.to[0], c.to[1]);
  if (path.end) ctx.lineTo(path.end[0], path.end[1]);
  ctx.stroke();
}

// Draw one shape onto any 2D context (the live canvas or an export canvas).
export function drawShape(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.save();
  if (s.rotation !== 0) {
    const box = getBoundingBox(s);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(s.rotation);
    ctx.translate(-cx, -cy);
  }
  ctx.globalAlpha = s.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.type === "text") {
    ctx.fillStyle = s.stroke;
    ctx.font = fontCss(s);
    ctx.textBaseline = "top";
    const lh = lineHeightOf(s);
    (s.text ?? "").split("\n").forEach((line, i) => ctx.fillText(line, s.x, s.y + i * lh));
  } else if (s.type === "path") {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.setLineDash(dashFor(s.strokeStyle, s.strokeWidth));
    drawPath(ctx, s);
  } else {
    const outline = outlineOf(s);
    if (outline.clip && s.fill !== "none") {
      ctx.save();
      clipPath(ctx, outline.clip);
      ctx.clip();
      if (s.fillStyle === "solid") {
        ctx.fillStyle = s.fill;
        ctx.fillRect(s.x - 2, s.y - 2, s.width + 4, s.height + 4);
      } else {
        ctx.strokeStyle = s.fill;
        ctx.lineWidth = Math.max(1, s.strokeWidth * 0.7);
        ctx.setLineDash([]);
        for (const line of outline.hatch) strokePolyline(ctx, line);
      }
      ctx.restore();
    }
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = s.strokeWidth;
    ctx.setLineDash(dashFor(s.strokeStyle, s.strokeWidth));
    for (const stroke of outline.strokes) strokePolyline(ctx, stroke);
  }
  ctx.restore();
}

// Freehand strokes: a Catmull-Rom spline through the sampled points,
// drawn as cubic Béziers.
function drawPath(ctx: CanvasRenderingContext2D, s: Shape): void {
  const pts = s.points ?? [];
  if (pts.length < 2) {
    if (pts.length === 1) {
      // A single click leaves a dot.
      ctx.fillStyle = s.stroke;
      ctx.beginPath();
      ctx.arc(s.x + pts[0][0], s.y + pts[0][1], s.strokeWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(s.x + pts[0][0], s.y + pts[0][1]);
  if (pts.length === 2) ctx.lineTo(s.x + pts[1][0], s.y + pts[1][1]);
  else {
    for (const seg of catmullRomSegments(pts)) {
      ctx.bezierCurveTo(
        s.x + seg.c1[0], s.y + seg.c1[1],
        s.x + seg.c2[0], s.y + seg.c2[1],
        s.x + seg.end[0], s.y + seg.end[1],
      );
    }
  }
  ctx.stroke();
}
