import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape, type Shape } from "@liveboard/shared";
import { outlineOf, randomFrom, roundedRectPoints, seedOf, smooth, type Pt } from "../src/rough.ts";

const rect = (id: string, props: Partial<Shape> = {}): Shape =>
  Object.assign(createShape("rect", 100, 100, 0), { id, width: 200, height: 120 }, props);
const flat = (o: ReturnType<typeof outlineOf>) => o.strokes.flat();

// Distance from a point to a segment.
function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

test("the same shape always looks the same; a different shape looks different", () => {
  assert.deepEqual(outlineOf(rect("same")), outlineOf(rect("same")), "same id, same wobble, on every machine");
  assert.notDeepEqual(outlineOf(rect("one")).strokes, outlineOf(rect("two")).strokes);
  // The random source is a pure function of the seed.
  const a = randomFrom(seedOf("x"));
  const b = randomFrom(seedOf("x"));
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seedOf("x"), seedOf("y"));
});

test("roughness 0 draws exact geometry", () => {
  const line = Object.assign(createShape("line", 0, 0, 0), { id: "l", points: [[0, 0], [100, 50]] as [number, number][], roughness: 0 });
  assert.deepEqual(outlineOf(line).strokes, [[[0, 0], [100, 50]]], "one straight stroke between the two points");

  const sharp = rect("r", { roughness: 0, edges: "sharp" });
  assert.deepEqual(outlineOf(sharp).strokes, [[[100, 100], [300, 100], [300, 220], [100, 220], [100, 100]]]);
});

test("a wobbly line stays close to the line it is trying to be", () => {
  for (const roughness of [1, 2]) {
    for (let i = 0; i < 40; i++) {
      const s = Object.assign(createShape("line", 0, 0, 0), { id: `w${roughness}-${i}`, points: [[0, 0], [300, 120]] as [number, number][], roughness });
      for (const stroke of outlineOf(s).strokes) {
        for (const p of stroke) {
          // Allowed to wander a little, never to leave: a drawing, not a scribble.
          assert.ok(distToSegment(p, [0, 0], [300, 120]) < 4 + roughness * 8, `roughness ${roughness} strayed`);
        }
      }
    }
  }
});

test("rougher means wobblier", () => {
  const spread = (r: number) => {
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const s = Object.assign(createShape("line", 0, 0, 0), { id: `k${i}`, points: [[0, 0], [300, 0]] as [number, number][], roughness: r });
      for (const stroke of outlineOf(s).strokes) for (const p of stroke) total += Math.abs(p[1]);
    }
    return total;
  };
  assert.ok(spread(1) < spread(2), "wild is wobblier than sketchy");
  assert.ok(spread(0) < spread(1), "sketchy is wobblier than clean");
});

test("a sketched rectangle is two passes; a sketched circle does not quite close", () => {
  const sharp = outlineOf(rect("r1", { edges: "sharp" }));
  assert.equal(sharp.strokes.length, 8, "four edges, each drawn twice");
  const round = outlineOf(rect("r2"));
  assert.equal(round.strokes.length, 2, "a rounded rectangle is two loops");

  const circle = Object.assign(createShape("circle", 0, 0, 0), { id: "c", width: 200, height: 200 });
  const [pass] = outlineOf(circle).strokes;
  const gap = Math.hypot(pass[0][0] - pass[pass.length - 1][0], pass[0][1] - pass[pass.length - 1][1]);
  assert.ok(gap < 40, `ends are near each other (${gap.toFixed(1)}px apart)`);
  for (const p of flat(outlineOf(circle))) {
    const r = Math.hypot(p[0] - 100, p[1] - 100);
    assert.ok(Math.abs(r - 100) < 12, `points stay near the true circle (radius ${r.toFixed(1)})`);
  }
});

test("hatching: parallel lines with a steady gap, doubled for cross-hatch, none without a fill", () => {
  const none = outlineOf(rect("h0"));
  assert.equal(none.hatch.length, 0, "no fill, no hatching");
  const solid = outlineOf(rect("h1", { fill: "#fa5252", fillStyle: "solid" }));
  assert.equal(solid.hatch.length, 0, "solid fills are painted, not hatched");

  const hatched = outlineOf(rect("h2", { fill: "#fa5252", fillStyle: "hachure", roughness: 0 }));
  const cross = outlineOf(rect("h3", { fill: "#fa5252", fillStyle: "cross", roughness: 0 }));
  assert.ok(hatched.hatch.length > 10);
  assert.equal(cross.hatch.length, hatched.hatch.length * 2);
  // With no wobble the lines are exactly parallel and evenly spaced.
  const normalGap = (a: Pt[], b: Pt[]) => Math.abs((b[0][0] - a[0][0]) * (a[1][1] - a[0][1]) - (b[0][1] - a[0][1]) * (a[1][0] - a[0][0])) / Math.hypot(a[1][0] - a[0][0], a[1][1] - a[0][1]);
  const gaps = hatched.hatch.slice(1, 8).map((line, i) => normalGap(hatched.hatch[i], line));
  for (const g of gaps) assert.ok(Math.abs(g - gaps[0]) < 0.5, "even spacing");
  assert.ok(hatched.clip && hatched.clip.kind === "rect", "and a clip region to keep them inside the shape");
});

test("rounded rectangle outlines have the right size", () => {
  const pts = roundedRectPoints(0, 0, 200, 100, 20);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= -0.001 && Math.max(...xs) <= 200.001);
  assert.ok(Math.min(...ys) >= -0.001 && Math.max(...ys) <= 100.001);
  assert.ok(!pts.some((p) => p[0] < 20 && p[1] < 20 && Math.hypot(p[0] - 20, p[1] - 20) > 20.01), "the corner is cut, not square");
});

test("smoothing turns a polyline into quadratic curves through the midpoints", () => {
  assert.equal(smooth([[0, 0]]), undefined);
  assert.deepEqual(smooth([[0, 0], [10, 10]]), { start: [0, 0], curves: [], end: [10, 10] });
  const s = smooth([[0, 0], [10, 0], [20, 10], [30, 10]])!;
  assert.equal(s.curves.length, 2);
  assert.deepEqual(s.curves[0], { control: [10, 0], to: [15, 5] }, "ends at the midpoint of the next segment");
  assert.deepEqual(s.end, [30, 10]);
});

test("hand-drawing 1,000 shapes is fast, and cached shapes cost nothing", () => {
  const shapes = Array.from({ length: 1000 }, (_, i) => rect(`perf-${i}`, { fill: "#74c0fc", fillStyle: i % 2 ? "cross" : "hachure" }));
  const t0 = performance.now();
  for (const s of shapes) outlineOf(s);
  const first = performance.now() - t0;
  const t1 = performance.now();
  for (const s of shapes) outlineOf(s);
  const again = performance.now() - t1;
  assert.ok(first < 1500, `1,000 shapes took ${first.toFixed(0)} ms`);
  assert.ok(again < 20, `the cached pass took ${again.toFixed(1)} ms`);
});
