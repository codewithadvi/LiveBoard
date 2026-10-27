import type { HLC } from "./hlc";

// Limits and shape checks applied to everything a client sends. The server
// never trusts the browser: one bad value saved in the log would be replayed
// into every other user's renderer, forever.

export const MAX_SHAPES_PER_BOARD = 10_000;
export const MAX_POINTS_PER_SHAPE = 5_000;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_COORD = 10_000_000;
const MAX_TAGS_PER_REMOVE = 200;

const isNum = (v: unknown, min = -MAX_COORD, max = MAX_COORD): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

const oneOf = (allowed: readonly string[]) => (v: unknown) => typeof v === "string" && allowed.includes(v);

// "none", a hex colour, a named colour, or rgb()/hsl() with plain numbers.
const COLOUR = /^(none|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(rgb|hsl)a?\([0-9\s.,%]{1,40}\))$/;

const CHECKS: Record<string, (v: unknown) => boolean> = {
  x: (v) => isNum(v),
  y: (v) => isNum(v),
  width: (v) => isNum(v, 0),
  height: (v) => isNum(v, 0),
  rotation: (v) => isNum(v, -1000, 1000),
  zIndex: (v) => isNum(v, -1e9, 1e9),
  strokeWidth: (v) => isNum(v, 0, 200),
  opacity: (v) => isNum(v, 0, 1),
  roughness: (v) => isNum(v, 0, 2),
  fontSize: (v) => isNum(v, 6, 300),
  fillStyle: oneOf(["hachure", "cross", "solid"]),
  strokeStyle: oneOf(["solid", "dashed", "dotted"]),
  edges: oneOf(["sharp", "round"]),
  fontFamily: oneOf(["hand", "sans", "mono"]),
  fill: (v) => typeof v === "string" && COLOUR.test(v),
  stroke: (v) => typeof v === "string" && COLOUR.test(v),
  points: (v) =>
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= MAX_POINTS_PER_SHAPE &&
    v.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1])),
};

// True only if every property is a known one holding a sensible value.
export function validProps(props: unknown): boolean {
  if (typeof props !== "object" || props === null || Array.isArray(props)) return false;
  return Object.entries(props).every(([name, value]) => value === undefined || (CHECKS[name]?.(value) ?? false));
}

export function validHlc(h: unknown): h is HLC {
  if (typeof h !== "object" || h === null) return false;
  const { t, c, id } = h as Record<string, unknown>;
  return isNum(t, 0, 1e15) && isNum(c, 0, 1e9) && typeof id === "string" && id.length > 0 && id.length <= 64;
}

export function validTags(tags: unknown): tags is HLC[] {
  return Array.isArray(tags) && tags.length <= MAX_TAGS_PER_REMOVE && tags.every(validHlc);
}

export function validShapeId(id: unknown): id is string {
  return typeof id === "string" && id.length >= 1 && id.length <= 64;
}
