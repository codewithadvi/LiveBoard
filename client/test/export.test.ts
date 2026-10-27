import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape } from "@liveboard/shared";
import { catmullRomSegments } from "../src/curve.ts";
import { contentBounds, shapesToSvg } from "../src/exportSvg.ts";

test("Catmull-Rom segments end at the next point and head along the neighbours' direction", () => {
  const pts: [number, number][] = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const segs = catmullRomSegments(pts);
  assert.equal(segs.length, 3);
  segs.forEach((seg, i) => assert.deepEqual(seg.end, pts[i + 1]));
  // Collinear points give a straight curve: every control point stays on y = 0.
  for (const seg of segs) assert.deepEqual([seg.c1[1], seg.c2[1]], [0, 0]);
  // Interior control point: c1 = p1 + (p2 - p0) / 6 = 10 + 20/6
  assert.ok(Math.abs(segs[1].c1[0] - (10 + 20 / 6)) < 1e-9);
});

function sampleBoard() {
  const rect = createShape("rect", 10, 10, 0);
  Object.assign(rect, { width: 50, height: 30, fill: "#74c0fc" }); // hatched
  const circle = createShape("circle", 100, 10, 1);
  Object.assign(circle, { width: 40, height: 40, fill: "#ffd43b", fillStyle: "solid" });
  const line = createShape("line", 0, 100, 2);
  line.points = [[0, 0], [50, 20]];
  line.strokeStyle = "dashed";
  const arrow = createShape("arrow", 0, 150, 3);
  arrow.points = [[0, 0], [50, 0]];
  const pen = createShape("path", 0, 200, 4);
  pen.points = [[0, 0], [10, 8], [20, 3], [30, 12]];
  const note = createShape("text", 5, 5, 5);
  Object.assign(note, { text: 'a < b & "c"\nsecond line', width: 60, height: 40 });
  return { rect, circle, line, arrow, pen, note };
}

test("SVG export draws every kind of shape, in layer order, and never writes a broken number", () => {
  const { rect, circle, line, arrow, pen, note } = sampleBoard();
  const svg = shapesToSvg([note, pen, arrow, line, circle, rect]); // deliberately shuffled

  assert.ok(svg.startsWith("<svg ") && svg.trim().endsWith("</svg>"));
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/, "no broken numbers");
  assert.ok(svg.includes("<clipPath"), "a hatched fill is clipped to its shape");
  assert.ok(svg.includes("<ellipse") && svg.includes('fill="#ffd43b"'), "a solid circle is filled directly");
  assert.ok(svg.includes("stroke-dasharray"), "dashed lines stay dashed");
  assert.ok(/<path d="M[\d.,-]+ Q/.test(svg), "sketchy outlines are smooth curves");
  assert.ok(svg.includes("<path d=\"M0,200 C"), "pen strokes are Catmull-Rom curves");
  assert.ok(svg.includes("Caveat"), "text uses the handwriting font");
  assert.ok(svg.includes("a &lt; b &amp; &quot;c&quot;"), "text is escaped");
  assert.equal((svg.match(/<tspan/g) ?? []).length, 2, "one tspan per line");
  assert.ok(svg.indexOf("<clipPath") < svg.indexOf("<text"), "lower layers come first");
  // Every opened element is closed (the text and clipPath ones have separate closers).
  assert.equal((svg.match(/<clipPath/g) ?? []).length, (svg.match(/<\/clipPath>/g) ?? []).length);
  assert.equal((svg.match(/<text/g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length);
});

test("a clean shape and a sketchy shape are different pictures, but the same shape twice is identical", () => {
  const a = sampleBoard().rect;
  const sketchy = shapesToSvg([a]);
  const clean = shapesToSvg([{ ...a, roughness: 0 }]);
  assert.notEqual(sketchy, clean);
  assert.equal(shapesToSvg([a]), sketchy, "same id, same wobble");
});

test("the background can be switched off for transparent exports", () => {
  const { rect } = sampleBoard();
  assert.ok(shapesToSvg([rect]).includes('fill="#ffffff"'));
  assert.ok(!shapesToSvg([rect], { background: null }).includes('fill="#ffffff"'));
  assert.ok(shapesToSvg([rect], { background: "#101010" }).includes('fill="#101010"'));
});

test("rotated shapes carry a rotate transform about their centre", () => {
  const rect = createShape("rect", 0, 0, 0);
  Object.assign(rect, { width: 100, height: 20, rotation: Math.PI / 2 });
  assert.ok(shapesToSvg([rect]).includes('transform="rotate(90 50 10)"'));
});

test("content bounds cover everything with padding, including rotation", () => {
  assert.deepEqual(contentBounds([]), { x: 0, y: 0, width: 100, height: 100 });
  const bar = createShape("rect", 0, 0, 0);
  Object.assign(bar, { width: 100, height: 10, strokeWidth: 0, roughness: 0 });
  const flat = contentBounds([bar]);
  assert.ok(Math.abs(flat.width - 148) < 1e-9 && Math.abs(flat.height - 58) < 1e-9, `${flat.width} x ${flat.height}`);
  bar.rotation = Math.PI / 2; // now tall and thin
  const tall = contentBounds([bar]);
  assert.ok(tall.height > tall.width, "rotated bar is taller than wide");
  // Wobbly shapes get a little extra room so their lines are not clipped.
  const wobbly = { ...bar, rotation: 0, roughness: 2 };
  assert.ok(contentBounds([wobbly]).width > flat.width);
});
