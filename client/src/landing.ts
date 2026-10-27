import { createShape, type Shape } from "@liveboard/shared";
import { drawShape } from "./drawing";
import { measureText } from "./text";

// The page behind the landing hero is a small, real, local whiteboard: a few
// sketches drawn with the same renderer the app uses, and a pen you can try
// right away. Nothing here is saved or sent anywhere.

const MARKERS = ["#e03131", "#1971c2", "#2f9e44", "#9c36b5", "#f08c00"];

function shape(type: Parameters<typeof createShape>[0], id: string, props: Partial<Shape>): Shape {
  return Object.assign(createShape(type, 0, 0, 0), { id }, props);
}

function label(id: string, text: string, x: number, y: number, fontSize: number, extra: Partial<Shape> = {}): Shape {
  const s = shape("text", id, { x, y, text, fontSize, ...extra });
  return Object.assign(s, measureText(text, s));
}

function scene(w: number, h: number): Shape[] {
  if (w < 820) return [];
  const x0 = Math.round(w * 0.6);
  const rw = Math.min(300, w * 0.22);
  const idea = shape("rect", "scene-idea", {
    x: x0,
    y: h * 0.15,
    width: rw,
    height: 150,
    fill: "#b197fc",
    stroke: "#1b2236",
    strokeWidth: 2.5,
    roughness: 1.4,
    zIndex: 1,
  });
  const circle = shape("circle", "scene-circle", {
    x: x0 + rw + 90,
    y: h * 0.22,
    width: 130,
    height: 130,
    fill: "#ffd43b",
    fillStyle: "cross",
    roughness: 1.4,
    strokeWidth: 2.5,
    zIndex: 2,
  });
  const arrow = shape("arrow", "scene-arrow", {
    x: x0 + rw + 12,
    y: h * 0.15 + 78,
    points: [[0, 0], [66, 18]],
    strokeWidth: 3,
    roughness: 1.4,
    zIndex: 3,
  });
  const sticky = shape("rect", "scene-sticky", {
    x: x0 + 30,
    y: h * 0.52,
    width: 200,
    height: 136,
    fill: "#ffec99",
    fillStyle: "solid",
    edges: "sharp",
    rotation: -0.06,
    stroke: "#c9a800",
    strokeWidth: 1.5,
    roughness: 0.8,
    zIndex: 4,
  });
  const wave = shape("path", "scene-wave", {
    x: x0 - 10,
    y: h * 0.84,
    points: Array.from({ length: 36 }, (_, i) => [i * 10, Math.sin(i / 2.6) * 14] as [number, number]),
    stroke: "#e03131",
    strokeWidth: 3.5,
    zIndex: 5,
  });
  const circleCaption = label("scene-t3", "draw together", x0 + rw + 70, h * 0.22 + 150, 34, { rotation: 0.04, stroke: "#1971c2", zIndex: 8 });
  return [
    idea,
    label("scene-t1", "big ideas", x0 + 24, h * 0.15 + 46, 52, { zIndex: 6 }),
    circle,
    arrow,
    sticky,
    label("scene-t2", "ship it\non Friday", x0 + 62, h * 0.52 + 28, 38, { rotation: -0.06, stroke: "#5c4a00", zIndex: 7 }),
    wave,
    circleCaption,
  ];
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.5, 13);
  ctx.lineTo(8, 20);
  ctx.lineTo(11, 18.5);
  ctx.lineTo(7.5, 12);
  ctx.lineTo(13, 12);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fill();
  ctx.font = '600 12px "Bricolage Grotesque Variable", system-ui, sans-serif';
  ctx.textBaseline = "middle";
  const w = ctx.measureText(name).width;
  ctx.beginPath();
  ctx.roundRect(14, 17, w + 12, 20, 10);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(name, 20, 27.5);
  ctx.restore();
}

export function startLandingPad(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  let strokes: Shape[] = [];
  let current: Shape | null = null;
  let colorIndex = 0;
  let scenery: Shape[] = [];

  const render = () => {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of scenery) drawShape(ctx, s);
    const idea = scenery.find((s) => s.id === "scene-idea");
    const sticky = scenery.find((s) => s.id === "scene-sticky");
    if (idea) drawCursor(ctx, idea.x + idea.width - 44, idea.y + idea.height - 30, "Maya", "#e03131");
    if (sticky) drawCursor(ctx, sticky.x + sticky.width - 20, sticky.y + sticky.height - 6, "Ada", "#1971c2");
    for (const s of strokes) drawShape(ctx, s);
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    scenery = scene(window.innerWidth, window.innerHeight);
    render();
  };
  window.addEventListener("resize", resize);
  resize();
  // The handwriting font arrives a moment after the first paint.
  void document.fonts.ready.then(resize);

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const pen = createShape("path", e.offsetX, e.offsetY, strokes.length);
    pen.stroke = MARKERS[colorIndex++ % MARKERS.length];
    pen.strokeWidth = 3.5;
    current = pen;
    strokes.push(pen);
    render();
  });
  canvas.addEventListener("pointermove", (e) => {
    const pen = current;
    if (!pen) return;
    // A new shape object each time, so cached geometry never goes stale.
    const points = [...(pen.points ?? []), [e.offsetX - pen.x, e.offsetY - pen.y] as [number, number]];
    const next = { ...pen, points };
    strokes[strokes.indexOf(pen)] = next;
    current = next;
    render();
  });
  const end = () => {
    current = null;
    if (strokes.length > 24) strokes = strokes.slice(-24);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}
