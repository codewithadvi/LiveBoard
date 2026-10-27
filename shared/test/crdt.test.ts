import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCrdt, canonical, emptyDoc, materializeShape, mergeDocs, liveTags, type CrdtOp, type DocState } from "../src/crdt.ts";
import { compareHLC, HLCClock } from "../src/hlc.ts";
import { rng, shuffle } from "./helpers.ts";

// Several simulated users each make edits against their own replica, creating
// operations stamped with their own clock.
function generateOps(seed: number, users = 4, steps = 60): CrdtOp[] {
  const r = rng(seed);
  let wall = 1_000;
  const clocks = Array.from({ length: users }, (_, i) => new HLCClock(`u${i}`, () => wall + r.int(3)));
  const replicas = Array.from({ length: users }, () => emptyDoc());
  const ops: CrdtOp[] = [];
  const ids = ["s1", "s2", "s3"];

  for (let step = 0; step < steps; step++) {
    wall += r.int(2); // time barely moves, so many ops are truly concurrent
    const u = r.int(users);
    const doc = replicas[u];
    const id = r.pick(ids);
    const known = doc.shapes[id];
    let op: CrdtOp;
    if (!known?.type || r.chance(0.15)) {
      op = { kind: "add", id, type: "rect", tag: clocks[u].tick(), props: { x: r.int(100), y: r.int(100) } };
    } else if (r.chance(0.2)) {
      op = { kind: "remove", id, tags: liveTags(known) };
    } else {
      const props = r.chance(0.5) ? { x: r.int(100) } : r.chance(0.5) ? { y: r.int(100) } : { x: r.int(100), y: r.int(100), width: r.int(50) };
      op = { kind: "set", id, props, ts: clocks[u].tick() };
    }
    applyCrdt(doc, op);
    ops.push(op);
    // Sometimes a replica hears about some earlier ops from others.
    for (const other of ops) {
      if (r.chance(0.1)) {
        applyCrdt(doc, other);
        if (other.kind === "add") clocks[u].receive(other.tag);
        if (other.kind === "set") clocks[u].receive(other.ts);
      }
    }
  }
  return ops;
}

function replay(ops: CrdtOp[]): DocState {
  const doc = emptyDoc();
  for (const op of ops) applyCrdt(doc, op);
  return doc;
}

test("replicas converge whatever order operations arrive in, with duplicates", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const ops = generateOps(seed);
    const reference = canonical(replay(ops));
    const r = rng(seed * 7919);
    for (let trial = 0; trial < 8; trial++) {
      const delivered = shuffle([...ops, ...ops.filter(() => r.chance(0.3))], r);
      assert.equal(canonical(replay(delivered)), reference, `seed ${seed} trial ${trial}`);
    }
  }
});

test("merge is commutative, associative and idempotent", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const ops = generateOps(seed, 3, 40);
    const r = rng(seed);
    const parts = [0, 1, 2].map(() => replay(ops.filter(() => r.chance(0.6))));
    const [a, b, c] = parts;
    assert.equal(canonical(mergeDocs(a, b)), canonical(mergeDocs(b, a)), "commutative");
    assert.equal(
      canonical(mergeDocs(mergeDocs(a, b), c)),
      canonical(mergeDocs(a, mergeDocs(b, c))),
      "associative",
    );
    assert.equal(canonical(mergeDocs(a, a)), canonical(a), "idempotent");
  }
});

test("a concurrent add survives a remove that did not observe it (OR-Set)", () => {
  const a = new HLCClock("A", () => 100);
  const b = new HLCClock("B", () => 100);
  const first = a.tick();
  const add1: CrdtOp = { kind: "add", id: "s", type: "rect", tag: first, props: { x: 1 } };
  const remove: CrdtOp = { kind: "remove", id: "s", tags: [first] }; // A removes what it saw
  const add2: CrdtOp = { kind: "add", id: "s", type: "rect", tag: b.tick(), props: {} }; // B adds concurrently
  for (const order of [[add1, remove, add2], [add1, add2, remove], [add2, add1, remove]]) {
    const doc = replay(order);
    assert.ok(materializeShape(doc, "s"), "shape must still exist");
  }
  assert.equal(materializeShape(replay([add1, remove]), "s"), undefined);
});

test("two users editing different properties both keep their change", () => {
  const a = new HLCClock("A", () => 100);
  const b = new HLCClock("B", () => 100);
  const add: CrdtOp = { kind: "add", id: "s", type: "rect", tag: a.tick(), props: { x: 0, y: 0 } };
  const moveX: CrdtOp = { kind: "set", id: "s", props: { x: 50 }, ts: a.tick() };
  const moveY: CrdtOp = { kind: "set", id: "s", props: { y: 70 }, ts: b.tick() };
  for (const order of [[add, moveX, moveY], [add, moveY, moveX]]) {
    const shape = materializeShape(replay(order), "s")!;
    assert.equal(shape.x, 50);
    assert.equal(shape.y, 70);
  }
});

test("same property: the later HLC wins, and ties break by client id", () => {
  const add: CrdtOp = { kind: "add", id: "s", type: "rect", tag: { t: 1, c: 0, id: "A" }, props: { x: 0 } };
  const lo: CrdtOp = { kind: "set", id: "s", props: { x: 1 }, ts: { t: 5, c: 0, id: "A" } };
  const hi: CrdtOp = { kind: "set", id: "s", props: { x: 2 }, ts: { t: 5, c: 0, id: "B" } };
  assert.equal(materializeShape(replay([add, lo, hi]), "s")!.x, 2);
  assert.equal(materializeShape(replay([add, hi, lo]), "s")!.x, 2);
});

test("HLC: a received timestamp pulls the local clock forward", () => {
  const behind = new HLCClock("B", () => 100);
  const ahead = new HLCClock("A", () => 5_000);
  const remote = ahead.tick();
  behind.receive(remote);
  assert.ok(compareHLC(behind.tick(), remote) > 0, "events after receiving are ordered after it");
});

test("HLC: ticks never repeat or go backwards even if the wall clock stalls or reverses", () => {
  let wall = 1_000;
  const clock = new HLCClock("A", () => wall);
  let prev = clock.tick();
  for (let i = 0; i < 100; i++) {
    wall += i % 7 === 0 ? -50 : i % 3 === 0 ? 0 : 5;
    const next = clock.tick();
    assert.ok(compareHLC(next, prev) > 0);
    prev = next;
  }
});
