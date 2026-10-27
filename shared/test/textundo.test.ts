import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape } from "../src/shapes.ts";
import { Pair } from "./pair.ts";

function setup() {
  const net = new Pair();
  const alice = net.add("alice");
  const bob = net.add("bob");
  const note = createShape("text", 0, 0, 0);
  alice.addShape(note);
  net.flush();
  return { net, alice, bob, id: note.id };
}

// Type one character at a time, like a keyboard, `gap` ms apart.
function type(s: ReturnType<typeof setup>, who: "alice" | "bob", text: string, gap = 100) {
  for (const ch of text) {
    s.net.clock += gap;
    const e = s[who];
    e.editText(s.id, e.textOf(s.id) + ch);
  }
}

test("fast typing is one undo step; a pause starts a new one", () => {
  const s = setup();
  type(s, "alice", "hello", 100);
  s.net.clock += 5_000;
  type(s, "alice", " world", 100);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "hello world");

  s.alice.undoText(s.id);
  assert.equal(s.alice.textOf(s.id), "hello", "the second burst is undone as one step");
  s.alice.undoText(s.id);
  assert.equal(s.alice.textOf(s.id), "", "and then the first");
  assert.equal(s.alice.undoText(s.id), null, "nothing left to undo");

  s.alice.redoText(s.id);
  s.alice.redoText(s.id);
  assert.equal(s.alice.textOf(s.id), "hello world");
  s.net.flush();
  assert.equal(s.bob.textOf(s.id), "hello world", "undo and redo reach everyone");
});

test("undo still removes the right letters after someone else typed in front", () => {
  const s = setup();
  type(s, "alice", "abc");
  s.net.flush();
  s.net.clock += 5_000;
  s.bob.editText(s.id, "X" + s.bob.textOf(s.id)); // Bob adds a letter at the very start
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "Xabc");

  s.alice.undoText(s.id);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "X", "only Alice's letters go; Bob's stays");
  assert.equal(s.bob.textOf(s.id), "X");

  s.alice.redoText(s.id);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "Xabc", "redo puts them back after Bob's letter");
  assert.equal(s.bob.textOf(s.id), "Xabc");
});

test("undoing a deletion puts the letter back in the right place", () => {
  const s = setup();
  s.alice.editText(s.id, "hello");
  s.net.flush();
  s.net.clock += 5_000;
  s.alice.editText(s.id, "helo"); // delete one l
  s.bob.editText(s.id, "ZZhello"); // meanwhile Bob types at the start
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), s.bob.textOf(s.id));

  s.alice.undoText(s.id);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "ZZhello");
  assert.equal(s.bob.textOf(s.id), "ZZhello");
});

test("two people typing at once: each undoes only their own letters", () => {
  const s = setup();
  s.alice.editText(s.id, "AAA");
  s.bob.editText(s.id, "BBB");
  s.net.flush();
  const merged = s.alice.textOf(s.id);
  assert.deepEqual([...merged].sort(), [..."AAABBB"].sort());

  s.alice.undoText(s.id);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "BBB");
  assert.equal(s.bob.textOf(s.id), "BBB");
  s.bob.undoText(s.id);
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "");
});

test("undo is harmless when someone else already deleted the text", () => {
  const s = setup();
  type(s, "alice", "abc");
  s.net.flush();
  s.bob.editText(s.id, ""); // Bob wipes the box
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "");

  s.alice.undoText(s.id); // would delete "abc", which is already gone
  s.net.flush();
  assert.equal(s.alice.textOf(s.id), "");
  assert.equal(s.bob.textOf(s.id), "");
});

test("a new edit clears the redo history", () => {
  const s = setup();
  s.alice.editText(s.id, "one");
  s.net.clock += 5_000;
  s.alice.undoText(s.id);
  s.alice.editText(s.id, "two");
  assert.equal(s.alice.redoText(s.id), null);
});
