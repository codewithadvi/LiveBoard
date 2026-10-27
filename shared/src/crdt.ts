import { compareHLC, hlcKey, type HLC } from "./hlc";
import { defaultProps, SYNCED_PROPS, type Shape, type ShapeProps, type ShapeType } from "./shapes";

// ---- state -----------------------------------------------------------------
//
// A shape is two CRDTs glued together:
//   * existence: an OR-Set (Observed-Remove Set) of "add tags". A remove only
//     cancels the specific adds it observed, so a concurrent add survives.
//   * each property: a Last-Write-Wins register stamped with an HLC.
//
// Nothing is ever deleted from this structure, even removed shapes. Their
// registers and tags stay (as "tombstones") so late-arriving operations still
// land in the right place and every replica ends up identical.

export interface Register {
  value: unknown;
  ts: HLC;
}

export interface ShapeState {
  id: string;
  type?: ShapeType; // unknown until the add arrives (ops may arrive out of order)
  typeTag?: HLC; // the add that decided `type`: if adds disagree, the highest tag wins
  props: Record<string, Register>;
  adds: Record<string, HLC>; // OR-Set: add tags
  removes: Record<string, true>; // OR-Set: add tags that were observed and removed
}

// Text is not a CRDT. Its content and revision are owned by the OT layer.
export interface TextState {
  text: string;
  rev: number;
}

export interface DocState {
  shapes: Record<string, ShapeState>;
  texts: Record<string, TextState>;
}

export function emptyDoc(): DocState {
  return { shapes: {}, texts: {} };
}

// ---- operations ------------------------------------------------------------

export type CrdtOp =
  | { kind: "add"; id: string; type: ShapeType; tag: HLC; props: ShapeProps }
  | { kind: "set"; id: string; props: ShapeProps; ts: HLC }
  | { kind: "remove"; id: string; tags: HLC[] };

function shapeEntry(doc: DocState, id: string): ShapeState {
  return (doc.shapes[id] ??= { id, props: {}, adds: {}, removes: {} });
}

// Keep the register with the larger timestamp. This is a max, so it is
// commutative, associative and idempotent: the three laws a CRDT needs.
function writeRegister(shape: ShapeState, name: string, value: unknown, ts: HLC): void {
  const existing = shape.props[name];
  if (!existing || compareHLC(ts, existing.ts) > 0) {
    shape.props[name] = { value: structuredClone(value), ts };
  }
}

const SYNCED = new Set<string>(SYNCED_PROPS);

function writeProps(shape: ShapeState, props: ShapeProps, ts: HLC): void {
  for (const [name, value] of Object.entries(props)) {
    if (SYNCED.has(name) && value !== undefined) writeRegister(shape, name, value, ts);
  }
}

export function applyCrdt(doc: DocState, op: CrdtOp): string {
  const shape = shapeEntry(doc, op.id);
  switch (op.kind) {
    case "add":
      if (!shape.typeTag || compareHLC(op.tag, shape.typeTag) > 0) {
        shape.type = op.type;
        shape.typeTag = op.tag;
      }
      shape.adds[hlcKey(op.tag)] = op.tag;
      writeProps(shape, op.props, op.tag);
      break;
    case "set":
      writeProps(shape, op.props, op.ts);
      break;
    case "remove":
      for (const tag of op.tags) shape.removes[hlcKey(tag)] = true;
      break;
  }
  return op.id;
}

// ---- reading ---------------------------------------------------------------

export function liveTags(shape: ShapeState): HLC[] {
  return Object.entries(shape.adds)
    .filter(([key]) => !shape.removes[key])
    .map(([, tag]) => tag);
}

export function materializeShape(doc: DocState, id: string): Shape | undefined {
  const s = doc.shapes[id];
  if (!s || !s.type || liveTags(s).length === 0) return undefined;
  const shape = { ...defaultProps(s.type), id, type: s.type } as Shape;
  for (const [name, reg] of Object.entries(s.props)) {
    (shape as unknown as Record<string, unknown>)[name] = structuredClone(reg.value);
  }
  const text = doc.texts[id];
  if (s.type === "text") shape.text = text?.text ?? "";
  return shape;
}

// ---- merging whole states (used to test the CRDT laws directly) -------------

function mergeShape(a: ShapeState | undefined, b: ShapeState | undefined): ShapeState {
  const id = (a ?? b)!.id;
  const out: ShapeState = { id, props: {}, adds: {}, removes: {} };
  for (const side of [a, b]) {
    if (!side) continue;
    if (side.typeTag && (!out.typeTag || compareHLC(side.typeTag, out.typeTag) > 0)) {
      out.type = side.type;
      out.typeTag = side.typeTag;
    }
    Object.assign(out.adds, structuredClone(side.adds));
    Object.assign(out.removes, side.removes);
    for (const [name, reg] of Object.entries(side.props)) writeRegister(out, name, reg.value, reg.ts);
  }
  return out;
}

// Merges the CRDT part of two states. (Text is OT-managed and not merged here.)
export function mergeDocs(a: DocState, b: DocState): DocState {
  const out = emptyDoc();
  for (const id of new Set([...Object.keys(a.shapes), ...Object.keys(b.shapes)])) {
    out.shapes[id] = mergeShape(a.shapes[id], b.shapes[id]);
  }
  return out;
}

// Order-independent string form of the CRDT part, for equality checks.
export function canonical(doc: DocState): string {
  const sortObj = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortObj);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([k, val]) => [k, sortObj(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sortObj(doc.shapes));
}
