import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape, type Shape } from "@liveboard/shared";
import { cloneShapes, erasePath, normalizeRect, reorderZ, shapesInRect } from "../src/edit.ts";

const box = (id: string, z: number, x = 0, y = 0, w = 10, h = 10): Shape => {
  const s = createShape("rect", x, y, z);
  Object.assign(s, { id, width: w, height: h, strokeWidth: 0 });
  return s;
};
const order = (shapes: Shape[], changes: Map<string, number>) =>
  shapes
    .map((s) => ({ id: s.id, z: changes.get(s.id) ?? s.zIndex }))
    .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
    .map((s) => s.id)
    .join("");

test("bring to front / send to back keep the selection's own order", () => {
  const all = ["a", "b", "c", "d", "e"].map((id, i) => box(id, i));
  assert.equal(order(all, reorderZ(all, new Set(["b", "c"]), "front")), "adebc");
  assert.equal(order(all, reorderZ(all, new Set(["c", "d"]), "back")), "cdabe");
  // Only the moved shapes get new values: nobody else's z is rewritten.
  assert.deepEqual([...reorderZ(all, new Set(["a"]), "front").keys()], ["a"]);
});

test("forward / backward move the selection one step past its neighbour", () => {
  const all = ["a", "b", "c", "d"].map((id, i) => box(id, i));
  assert.equal(order(all, reorderZ(all, new Set(["b"]), "forward")), "acbd");
  assert.equal(order(all, reorderZ(all, new Set(["c"]), "backward")), "acbd".replace("acbd", "acbd"));
  assert.equal(order(all, reorderZ(all, new Set(["b", "c"]), "forward")), "adbc");
  assert.equal(order(all, reorderZ(all, new Set(["b", "c"]), "backward")), "bcad");
  assert.equal(reorderZ(all, new Set(["d"]), "forward").size, 0, "already on top: nothing to do");
  assert.equal(reorderZ(all, new Set(["a"]), "backward").size, 0, "already at the bottom: nothing to do");
});

test("stepping works with tied z values and many repeated moves", () => {
  const all = ["a", "b", "c"].map((id) => box(id, 5)); // all tied; ordered by id
  // Tied shapes cannot be separated by z alone, so a step forward clears the whole tie.
  assert.equal(order(all, reorderZ(all, new Set(["a"]), "forward")), "bca");
  let shapes = ["a", "b", "c", "d"].map((id, i) => box(id, i));
  for (let i = 0; i < 40; i++) {
    const changes = reorderZ(shapes, new Set(["a"]), i % 2 ? "backward" : "forward");
    shapes = shapes.map((s) => (changes.has(s.id) ? { ...s, zIndex: changes.get(s.id)! } : s));
  }
  assert.equal(order(shapes, new Map()), "abcd", "40 back-and-forth steps return to the start");
});

test("marquee selection picks every touched shape, using the rotated outline", () => {
  const near = box("near", 0, 10, 10);
  const far = box("far", 1, 500, 500);
  const long = box("long", 2, 100, 0, 200, 4);
  long.rotation = Math.PI / 2; // was a wide bar; now a tall bar centred at (200, 2)
  const all = [near, far, long];
  assert.deepEqual(normalizeRect(150, 90, 50, -50), { x: 50, y: -50, width: 100, height: 140 });
  assert.deepEqual(shapesInRect(all, normalizeRect(0, 0, 30, 30)).map((s) => s.id), ["near"]);
  // Hits the tall bar's new position (below where the wide bar used to be)...
  assert.deepEqual(shapesInRect(all, normalizeRect(195, 50, 205, 60)).map((s) => s.id), ["long"]);
  // ...and misses the place the wide bar used to be.
  assert.deepEqual(shapesInRect(all, normalizeRect(120, -1, 130, 5)).map((s) => s.id), []);
});

test("pasting makes new ids, offsets, and stacks the copies on top in the same order", () => {
  const a = box("a", 3, 0, 0);
  const b = box("b", 1, 50, 50);
  const t = createShape("text", 5, 5, 2);
  t.id = "t";
  t.text = "hello";
  let n = 0;
  const copies = cloneShapes([a, b, t], 20, 20, 10, () => `new-${n++}`);
  assert.deepEqual(copies.map((c) => c.shape.id), ["new-0", "new-1", "new-2"]);
  assert.deepEqual(copies.map((c) => c.shape.zIndex), [11, 12, 13], "above the old top, original order kept");
  assert.deepEqual([copies[0].shape.x, copies[0].shape.y], [50 + 20, 50 + 20], "b (lowest z) comes first");
  assert.equal(copies[1].text, "hello", "text travels separately, for OT");
  assert.equal(copies[1].shape.text, undefined);
  assert.equal(a.x, 0, "the originals are untouched");
});

test("erasing the middle of a stroke leaves two strokes", () => {
  const pen = createShape("path", 100, 100, 0);
  pen.points = Array.from({ length: 21 }, (_, i) => [i * 5, 0] as [number, number]); // 0..100 along x
  const r = erasePath(pen, 150, 100, 6); // centred on point index 10 (x = 150)
  assert.equal(r.removedAny, true);
  assert.equal(r.pieces.length, 2);
  assert.deepEqual(r.pieces[0].at(-1), [40, 0], "survivors end just before the eraser");
  assert.deepEqual(r.pieces[1][0], [60, 0], "and resume just after it");
  const kept = r.pieces.flat().length;
  assert.equal(kept, 21 - 3, "the three samples within the eraser are gone");
});

test("erasing the end trims the stroke; erasing a tiny stroke removes it; a graze still bites", () => {
  const pen = createShape("path", 0, 0, 0);
  pen.points = [[0, 0], [10, 0], [20, 0], [30, 0]];
  assert.equal(erasePath(pen, 0, 0, 5).pieces.length, 1, "trimmed, one piece left");
  const tiny = createShape("path", 0, 0, 0);
  tiny.points = [[0, 0], [10, 0]];
  assert.deepEqual(erasePath(tiny, 0, 0, 5).pieces, [], "a single point is not a stroke");
  // Pointer between two samples, farther than the radius from both:
  const graze = erasePath(pen, 15, 3, 2);
  assert.equal(graze.removedAny, true, "nearest sample is removed so the eraser always bites");
});
