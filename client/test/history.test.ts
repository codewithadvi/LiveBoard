import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape } from "@liveboard/shared";
import { History } from "../src/history.ts";
import { Pair } from "./harness.ts";

function setup() {
  const net = new Pair();
  const alice = net.add("alice");
  const bob = net.add("bob");
  const history = new History(alice);
  const box = createShape("rect", 10, 20, 0);
  alice.addShape(box);
  net.flush();
  return { net, alice, bob, history, box };
}

// What the input layer does at the end of a drag: change values, then record
// one undoable edit comparing before and after.
function drag(
  s: ReturnType<typeof setup>,
  props: Parameters<typeof s.alice.setProps>[1],
) {
  const before = Object.fromEntries(
    Object.keys(props).map((k) => [k, structuredClone((s.alice.shapes.get(s.box.id) as any)[k])]),
  );
  s.alice.setProps(s.box.id, props);
  const item = s.history.edited(s.box.id, before, props);
  if (item) s.history.record([item]);
  s.net.flush();
}

const shapeOf = (s: ReturnType<typeof setup>, who: "alice" | "bob" = "alice") => s[who].shapes.get(s.box.id)!;

test("undo reverts my own edit, redo brings it back, and both sync to others", () => {
  const s = setup();
  drag(s, { x: 300, y: 400 });
  assert.deepEqual([shapeOf(s, "bob").x, shapeOf(s, "bob").y], [300, 400]);

  s.history.undo();
  s.net.flush();
  assert.deepEqual([shapeOf(s).x, shapeOf(s).y], [10, 20]);
  assert.deepEqual([shapeOf(s, "bob").x, shapeOf(s, "bob").y], [10, 20], "undo is an ordinary synced edit");

  s.history.redo();
  s.net.flush();
  assert.deepEqual([shapeOf(s, "bob").x, shapeOf(s, "bob").y], [300, 400]);
});

test("undo does not overwrite a value someone else changed after me", () => {
  const s = setup();
  drag(s, { x: 300 });
  s.bob.setProps(s.box.id, { x: 999 }); // Bob moves it after Alice
  s.net.flush();
  assert.equal(shapeOf(s).x, 999);

  s.history.undo();
  s.net.flush();
  assert.equal(shapeOf(s, "bob").x, 999, "Bob's change is not clobbered by Alice's undo");
  assert.equal(shapeOf(s).x, 999);
});

test("undo reverts only the properties nobody else touched", () => {
  const s = setup();
  drag(s, { x: 300, y: 400 });
  s.bob.setProps(s.box.id, { y: 777 }); // Bob changes only y
  s.net.flush();

  s.history.undo();
  s.net.flush();
  assert.equal(shapeOf(s, "bob").x, 10, "x had no other editor, so it is reverted");
  assert.equal(shapeOf(s, "bob").y, 777, "y was changed by Bob, so it is left alone");
});

test("undo and redo of creating and deleting a shape", () => {
  const s = setup();
  const second = createShape("circle", 5, 5, 1);
  s.alice.addShape(second);
  s.history.record([{ kind: "created", id: second.id }]);
  s.net.flush();
  assert.ok(s.bob.shapes.has(second.id));

  s.history.undo();
  s.net.flush();
  assert.ok(!s.bob.shapes.has(second.id), "undoing a creation removes it for everyone");
  s.history.redo();
  s.net.flush();
  assert.ok(s.bob.shapes.has(second.id), "redo brings it back");

  s.alice.removeShape(second.id);
  s.history.record([{ kind: "deleted", id: second.id }]);
  s.net.flush();
  assert.ok(!s.bob.shapes.has(second.id));
  s.history.undo();
  s.net.flush();
  const back = s.bob.shapes.get(second.id)!;
  assert.ok(back, "undoing a delete restores the shape");
  assert.deepEqual([back.x, back.y, back.type], [5, 5, "circle"], "with the values it had");
});

test("a new action clears the redo stack, and an empty history is harmless", () => {
  const s = setup();
  assert.equal(s.history.undo(), false);
  assert.equal(s.history.redo(), false);
  drag(s, { x: 1 });
  s.history.undo();
  drag(s, { x: 2 });
  assert.equal(s.history.redo(), false);
});
