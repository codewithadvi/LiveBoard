import {
  INK,
  type Edges,
  type FillStyle,
  type FontFamily,
  type Shape,
  type ShapeProps,
  type ShapeType,
  type StrokeStyle,
} from "@liveboard/shared";

// "The look of a shape": everything the style panel can change. Which parts
// matter depends on the kind of shape: a pen stroke has no fill, a text box
// has no outline, only a rectangle has corners.

export interface Look {
  stroke: string; // outline colour, and the colour of text
  fill: string; // a colour, or "none"
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number; // 0 clean, 1 sketchy, 2 wild
  edges: Edges;
  fontFamily: FontFamily;
  fontSize: number;
  opacity: number;
}

export type LookKey = keyof Look;

export const DEFAULT_LOOK: Look = {
  stroke: INK,
  fill: "none",
  fillStyle: "hachure",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  edges: "round",
  fontFamily: "hand",
  fontSize: 28,
  opacity: 1,
};

const CLOSED: LookKey[] = ["stroke", "fill", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity"];

const APPLIES: Record<ShapeType, LookKey[]> = {
  rect: [...CLOSED, "edges"],
  circle: CLOSED,
  line: ["stroke", "strokeWidth", "strokeStyle", "roughness", "opacity"],
  arrow: ["stroke", "strokeWidth", "strokeStyle", "roughness", "opacity"],
  path: ["stroke", "strokeWidth", "strokeStyle", "opacity"],
  text: ["stroke", "fontFamily", "fontSize", "opacity"],
};

export const appliesTo = (type: ShapeType): readonly LookKey[] => APPLIES[type];

// Which look properties matter for a set of shape types (their union).
export function keysFor(types: Iterable<ShapeType>): Set<LookKey> {
  const keys = new Set<LookKey>();
  for (const t of types) for (const k of APPLIES[t]) keys.add(k);
  return keys;
}

// Only the parts of `change` that make sense for this kind of shape.
export function applicable(change: Partial<Look>, type: ShapeType): ShapeProps {
  const out: Record<string, unknown> = {};
  for (const key of APPLIES[type]) if (key in change) out[key] = change[key];
  return out as ShapeProps;
}

// Give a brand-new shape the current look (only the parts that apply to it).
export function applyLook(shape: Shape, look: Look): void {
  Object.assign(shape, applicable(look, shape.type));
}

export function lookOf(shape: Shape): Partial<Look> {
  const out: Record<string, unknown> = {};
  for (const key of APPLIES[shape.type]) out[key] = shape[key];
  return out as Partial<Look>;
}

export const MIXED = Symbol("mixed");

// The shared value of each property across the selection, or MIXED where the
// shapes disagree. Only shapes the property applies to are compared.
export function summarize(shapes: Shape[]): Partial<Record<LookKey, unknown | typeof MIXED>> {
  const out: Partial<Record<LookKey, unknown>> = {};
  for (const key of keysFor(shapes.map((s) => s.type))) {
    const values = shapes.filter((s) => APPLIES[s.type].includes(key)).map((s) => s[key]);
    out[key] = values.every((v) => v === values[0]) ? values[0] : MIXED;
  }
  return out;
}
