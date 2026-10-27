import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape } from "@liveboard/shared";
import { applicable, applyLook, DEFAULT_LOOK, keysFor, MIXED, summarize } from "../src/look.ts";

test("each kind of shape only takes the style properties that make sense for it", () => {
  const everything = { ...DEFAULT_LOOK, fill: "#fa5252", edges: "sharp" as const, fontSize: 40 };
  assert.deepEqual(Object.keys(applicable(everything, "path")).sort(), ["opacity", "stroke", "strokeStyle", "strokeWidth"]);
  assert.deepEqual(Object.keys(applicable(everything, "text")).sort(), ["fontFamily", "fontSize", "opacity", "stroke"]);
  assert.ok("edges" in applicable(everything, "rect"), "only rectangles have corners");
  assert.ok(!("edges" in applicable(everything, "circle")));
  assert.ok(!("fill" in applicable(everything, "line")), "lines have no fill");
  assert.ok(!("fontSize" in applicable(everything, "rect")));
});

test("a new shape gets the current look, but only the parts that apply", () => {
  const pen = createShape("path", 0, 0, 0);
  applyLook(pen, { ...DEFAULT_LOOK, stroke: "#e03131", strokeWidth: 6, roughness: 2, fill: "#51cf66" });
  assert.equal(pen.stroke, "#e03131");
  assert.equal(pen.strokeWidth, 6);
  assert.equal(pen.roughness, 0, "pen strokes are never redrawn wobbly");
  assert.equal(pen.fill, "none", "and have no fill");
});

test("the panel shows the shared value, or MIXED where the selection disagrees", () => {
  const a = createShape("rect", 0, 0, 0);
  const b = createShape("circle", 0, 0, 1);
  const t = createShape("text", 0, 0, 2);
  b.stroke = "#e03131";
  const s = summarize([a, b]);
  assert.equal(s.stroke, MIXED);
  assert.equal(s.strokeWidth, 2);
  assert.equal(s.roughness, 1);
  assert.equal(s.edges, "round", "only the rectangle has edges, so there is nothing to disagree with");
  const withText = summarize([a, t]);
  assert.ok("fontSize" in withText && "fill" in withText, "a mixed selection shows the union of controls");
  assert.deepEqual([...keysFor(["text"])].sort(), ["fontFamily", "fontSize", "opacity", "stroke"]);
});
