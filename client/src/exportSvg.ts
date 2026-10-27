import { getBoundingBox, type BoundingBox, type Shape } from "@liveboard/shared";
import { catmullRomSegments } from "./curve";
import { dashFor, FONT_STACKS, lineHeightOf } from "./drawing";
import { outlineOf, smooth, type ClipShape, type Pt } from "./rough";

const PADDING = 24;

// The smallest box containing every shape, including rotated ones.
export function contentBounds(shapes: Shape[]): BoundingBox {
  if (shapes.length === 0) return { x: 0, y: 0, width: 100, height: 100 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    const b = getBoundingBox(s);
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const corners: [number, number][] = [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
    ];
    for (const [px, py] of corners) {
      const dx = px - cx;
      const dy = py - cy;
      const x = cx + dx * Math.cos(s.rotation) - dy * Math.sin(s.rotation);
      const y = cy + dx * Math.sin(s.rotation) + dy * Math.cos(s.rotation);
      // A little extra for the wobble of hand-drawn lines.
      const slack = s.strokeWidth + s.roughness * 4;
      minX = Math.min(minX, x - slack);
      maxX = Math.max(maxX, x + slack);
      minY = Math.min(minY, y - slack);
      maxY = Math.max(maxY, y + slack);
    }
  }
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
}

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => String(Math.round(n * 100) / 100);
const xy = (p: Pt) => `${num(p[0])},${num(p[1])}`;

// The same rounding-off the canvas does, written as SVG path commands.
function smoothD(pts: Pt[]): string {
  const path = smooth(pts);
  if (!path) return "";
  let d = `M${xy(path.start)}`;
  for (const c of path.curves) d += ` Q${xy(c.control)} ${xy(c.to)}`;
  if (path.end) d += ` L${xy(path.end)}`;
  return d;
}

function clipElement(clip: ClipShape, attrs = ""): string {
  if (clip.kind === "rect") {
    const r = clip.radius > 0 ? ` rx="${num(clip.radius)}" ry="${num(clip.radius)}"` : "";
    return `<rect x="${num(clip.x)}" y="${num(clip.y)}" width="${num(clip.width)}" height="${num(clip.height)}"${r}${attrs}/>`;
  }
  return `<ellipse cx="${num(clip.cx)}" cy="${num(clip.cy)}" rx="${num(Math.max(clip.rx, 0))}" ry="${num(Math.max(clip.ry, 0))}"${attrs}/>`;
}

function shapeToSvg(s: Shape, nextId: () => string): string {
  const b = getBoundingBox(s);
  const rotate =
    s.rotation === 0
      ? ""
      : ` transform="rotate(${num((s.rotation * 180) / Math.PI)} ${num(b.x + b.width / 2)} ${num(b.y + b.height / 2)})"`;
  const opacity = s.opacity === 1 ? "" : ` opacity="${s.opacity}"`;
  const dash = dashFor(s.strokeStyle, s.strokeWidth);
  const dashAttr = dash.length ? ` stroke-dasharray="${dash.map(num).join(" ")}"` : "";
  const stroke = `fill="none" stroke="${esc(s.stroke)}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${dashAttr}`;

  if (s.type === "text") {
    const lh = lineHeightOf(s);
    const tspans = (s.text ?? "")
      .split("\n")
      .map((line, i) => `<tspan x="${num(s.x)}" y="${num(s.y + i * lh)}">${esc(line)}</tspan>`)
      .join("");
    return `<text font-family="${esc(FONT_STACKS[s.fontFamily].replace(/"/g, "'"))}" font-size="${s.fontSize}" dominant-baseline="hanging" fill="${esc(s.stroke)}"${opacity}${rotate}>${tspans}</text>`;
  }

  if (s.type === "path") {
    const pts = (s.points ?? []).map(([px, py]) => [s.x + px, s.y + py] as Pt);
    if (pts.length < 2) return "";
    let d = `M${xy(pts[0])}`;
    if (pts.length === 2) d += ` L${xy(pts[1])}`;
    else for (const seg of catmullRomSegments(pts)) d += ` C${num(s.x + seg.c1[0])},${num(s.y + seg.c1[1])} ${num(s.x + seg.c2[0])},${num(s.y + seg.c2[1])} ${num(s.x + seg.end[0])},${num(s.y + seg.end[1])}`;
    return `<path d="${d}" ${stroke}${opacity}${rotate}/>`;
  }

  const outline = outlineOf(s);
  let inner = "";
  if (outline.clip && s.fill !== "none") {
    if (s.fillStyle === "solid") {
      inner += clipElement(outline.clip, ` fill="${esc(s.fill)}" stroke="none"`);
    } else {
      const id = nextId();
      const lines = outline.hatch.map((line) => `M${xy(line[0])} L${xy(line[1])}`).join(" ");
      inner += `<clipPath id="${id}">${clipElement(outline.clip)}</clipPath>`;
      inner += `<path clip-path="url(#${id})" d="${lines}" fill="none" stroke="${esc(s.fill)}" stroke-width="${num(Math.max(1, s.strokeWidth * 0.7))}" stroke-linecap="round"/>`;
    }
  }
  const strokes = outline.strokes.map(smoothD).filter(Boolean).join(" ");
  if (strokes) inner += `<path d="${strokes}" ${stroke}/>`;
  return `<g${opacity}${rotate}>${inner}</g>`;
}

export interface SvgOptions {
  background?: string | null; // a colour, or null for a transparent image
}

// The whole board as a standalone SVG document, in layer order.
export function shapesToSvg(shapes: Shape[], options: SvgOptions = {}): string {
  const ordered = [...shapes].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1));
  const box = contentBounds(ordered);
  let n = 0;
  const nextId = () => `hatch-${n++}`;
  const body = ordered.map((s) => shapeToSvg(s, nextId)).filter(Boolean).join("\n  ");
  const background = options.background === undefined ? "#ffffff" : options.background;
  const bg = background
    ? `  <rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="${esc(background)}"/>\n`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(box.width)}" height="${num(box.height)}" ` +
    `viewBox="${num(box.x)} ${num(box.y)} ${num(box.width)} ${num(box.height)}">\n` +
    bg +
    `  ${body}\n</svg>\n`
  );
}
