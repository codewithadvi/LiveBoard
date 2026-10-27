import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape, type Shape } from "@liveboard/shared";
import { boxCenter, groupResize, groupRotate, hitBoxHandle } from "../src/geometry.ts";
import { rotatedBounds } from "../src/edit.ts";

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} ${a} vs ${b}`);
const box = (id: string, x: number, y: number, w: number, h: number): Shape => {
  const s = createShape("rect", x, y, 0);
  return Object.assign(s, { id, width: w, height: h });
};
const group = { x: 0, y: 0, width: 100, height: 50 };

test("dragging the bottom-right handle scales the whole group about the top-left corner", () => {
  const a = box("a", 0, 0, 20, 10);
  const b = box("b", 80, 40, 20, 10);
  const r = groupResize([a, b], group, "se", { x: 200, y: 100 }); // twice as big
  assert.deepEqual(r.get("a"), { x: 0, y: 0, width: 40, height: 20 });
  assert.deepEqual(r.get("b"), { x: 160, y: 80, width: 40, height: 20 });
});

test("dragging the top-left handle keeps the bottom-right corner fixed", () => {
  const a = box("a", 60, 30, 40, 20); // occupies the bottom-right corner of the group
  const r = groupResize([a], group, "nw", { x: -100, y: -50 }); // group becomes 200 x 100
  const p = r.get("a")!;
  near(p.x! + p.width!, 100, "right edge stays put");
  near(p.y! + p.height!, 50, "bottom edge stays put");
  near(p.width!, 80);
});

test("lines and strokes scale their points; text only moves", () => {
  const line = createShape("line", 10, 10, 0);
  line.points = [[0, 0], [30, 20]];
  const note = createShape("text", 50, 20, 0);
  Object.assign(note, { id: "t", width: 40, height: 20, text: "hi" });
  const r = groupResize([line, note], group, "se", { x: 200, y: 100 });
  assert.deepEqual(r.get(line.id)!.points, [[0, 0], [60, 40]]);
  assert.deepEqual([r.get(line.id)!.x, r.get(line.id)!.y], [20, 20]);
  assert.deepEqual(r.get("t"), { x: 100, y: 40 }, "no width/height written for text");
});

test("a group cannot be flipped inside out or collapsed to nothing", () => {
  const a = box("a", 0, 0, 100, 50);
  const r = groupResize([a], group, "se", { x: -500, y: -500 });
  const p = r.get("a")!;
  assert.ok(p.width! > 0 && p.height! > 0);
  near(p.width!, 5, "clamped to 5% of the original");
});

test("rotating a group turns each shape about the group's centre", () => {
  const left = box("l", 0, 20, 10, 10); // centre (5, 25)
  const right = box("r", 90, 20, 10, 10); // centre (95, 25)
  const c = boxCenter(group); // (50, 25)
  const r = groupRotate([left, right], c, Math.PI); // half a turn: they swap sides
  near(r.get("l")!.x!, 90, "left shape ends up on the right");
  near(r.get("r")!.x!, 0);
  near(r.get("l")!.y!, 20);
  near(r.get("l")!.rotation!, Math.PI, "and each shape turned too");
});

test("rotating by a quarter turn four times returns every shape to the start", () => {
  let shapes: Shape[] = [box("a", 3, 4, 20, 10), box("b", 70, 30, 12, 12)];
  const original = structuredClone(shapes);
  const c = boxCenter(group);
  for (let i = 0; i < 4; i++) {
    const r = groupRotate(shapes, c, Math.PI / 2);
    shapes = shapes.map((s) => ({ ...s, ...r.get(s.id)! }));
  }
  for (const [i, s] of shapes.entries()) {
    near(s.x, original[i].x, "x");
    near(s.y, original[i].y, "y");
    near(s.rotation % (Math.PI * 2), 0, "rotation");
  }
});

test("a rotated group still has the same overall footprint after turning half a turn", () => {
  const shapes = [box("a", 0, 0, 40, 10), box("b", 60, 30, 40, 20)];
  const before = [rotatedBounds(shapes[0]), rotatedBounds(shapes[1])];
  const c = boxCenter(group);
  const r = groupRotate(shapes, c, Math.PI);
  const after = shapes.map((s) => rotatedBounds({ ...s, ...r.get(s.id)! }));
  near(after[0].x, 100 - before[0].width, "mirrored through the centre");
  near(after[0].y, 50 - before[0].height);
  near(after[1].width, before[1].width);
});

test("group handles are found where they are drawn", () => {
  assert.equal(hitBoxHandle(group, { x: 100, y: 50 }, 1), "se");
  assert.equal(hitBoxHandle(group, { x: 50, y: -26 }, 1), "rotate");
  assert.equal(hitBoxHandle(group, { x: 50, y: 25 }, 1), undefined);
});
