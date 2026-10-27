export type ShapeType = "rect" | "circle" | "arrow" | "line" | "path" | "text";

export type Point = [number, number];

export type FillStyle = "hachure" | "cross" | "solid";
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type Edges = "sharp" | "round";
export type FontFamily = "hand" | "sans" | "mono";

export const FILL_STYLES: readonly FillStyle[] = ["hachure", "cross", "solid"];
export const STROKE_STYLES: readonly StrokeStyle[] = ["solid", "dashed", "dotted"];
export const EDGES: readonly Edges[] = ["sharp", "round"];
export const FONT_FAMILIES: readonly FontFamily[] = ["hand", "sans", "mono"];

export interface Shape {
  id: string;
  type: ShapeType;
  // Origin in world coordinates. Moving a shape only changes x and y.
  x: number;
  y: number;
  // Size for rect/circle/text. Ignored for shapes defined by points.
  width: number;
  height: number;
  // line/arrow/path: points relative to (x, y), so moving never touches them.
  points?: Point[];
  fill: string; // a colour, or "none"
  stroke: string; // outline colour; also the text colour
  strokeWidth: number;
  opacity: number;
  rotation: number;
  zIndex: number;
  // How the shape looks. These are properties like any other, so two people
  // changing different ones at once both win.
  roughness: number; // 0 clean, 1 sketchy, 2 wild
  fillStyle: FillStyle;
  strokeStyle: StrokeStyle;
  edges: Edges; // rectangle corners
  fontFamily: FontFamily; // text only
  fontSize: number; // text only
  // Text content is not a CRDT property: it is edited through OT.
  text?: string;
}

// Properties that live in last-write-wins registers, one register each.
export const SYNCED_PROPS = [
  "x",
  "y",
  "width",
  "height",
  "points",
  "fill",
  "stroke",
  "strokeWidth",
  "opacity",
  "rotation",
  "zIndex",
  "roughness",
  "fillStyle",
  "strokeStyle",
  "edges",
  "fontFamily",
  "fontSize",
] as const;
export type SyncedProp = (typeof SYNCED_PROPS)[number];

// Everything about a shape except its identity, as a value the CRDT can store.
export type ShapeProps = Partial<Pick<Shape, SyncedProp>>;

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const INK = "#1b2236";

export function defaultProps(type: ShapeType): Required<Omit<ShapeProps, "points">> & { points?: Point[] } {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    points: type === "line" || type === "arrow" || type === "path" ? [[0, 0]] : undefined,
    fill: "none",
    stroke: INK,
    strokeWidth: 2,
    opacity: 1,
    rotation: 0,
    zIndex: 0,
    // Freehand pen strokes and text are not redrawn wobbly: they already are.
    roughness: type === "path" || type === "text" ? 0 : 1,
    fillStyle: "hachure",
    strokeStyle: "solid",
    edges: "round",
    fontFamily: "hand",
    fontSize: 28,
  };
}

export function createShape(type: ShapeType, x: number, y: number, zIndex: number): Shape {
  return { ...defaultProps(type), id: crypto.randomUUID(), type, x, y, zIndex };
}

export function getBoundingBox(shape: Shape): BoundingBox {
  if (shape.points && shape.points.length > 0) {
    const xs = shape.points.map((p) => p[0]);
    const ys = shape.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: shape.x + minX,
      y: shape.y + minY,
      width: Math.max(...xs) - minX,
      height: Math.max(...ys) - minY,
    };
  }
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}
