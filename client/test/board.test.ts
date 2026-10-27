import assert from "node:assert/strict";
import { test } from "node:test";
import { createShape } from "@liveboard/shared";
import { Board } from "../src/board.ts";
import { reorderZ } from "../src/edit.ts";
import { Pair } from "./harness.ts";

test("two people adding a shape at the same instant never get the same layer", () => {
  const net = new Pair();
  const clients = ["alice", "bob", "carol", "dave", "erin", "frank"].map((n) => net.add(n));
  const boards = clients.map((c) => new Board(c));
  // Everyone asks for "the next layer up" before anyone has heard from anyone else.
  const zs = boards.map((b) => b.allocateZ());
  assert.equal(new Set(zs).size, zs.length, `layers collided: ${zs.join(", ")}`);
  for (const z of zs) assert.ok(z > 0 && z < 2, "still just above the board's top layer");
});

test("a new shape always lands above every existing one, even another person's", () => {
  const net = new Pair();
  const alice = net.add("alice");
  const bob = net.add("bob");
  const a = new Board(alice);
  const b = new Board(bob);
  for (let i = 0; i < 20; i++) {
    const owner = i % 2 ? alice : bob;
    const board = i % 2 ? a : b;
    const s = createShape("rect", i, 0, board.allocateZ());
    owner.addShape(s);
    net.flush();
    const topBefore = Math.max(...[...owner.shapes.values()].filter((x) => x.id !== s.id).map((x) => x.zIndex), -1);
    assert.ok(s.zIndex > topBefore, `shape ${i} is above everything already there`);
  }
});

test("because layers never tie, one step forward moves exactly one place", () => {
  const net = new Pair();
  const clients = ["alice", "bob", "carol"].map((n) => net.add(n));
  const boards = clients.map((c) => new Board(c));
  // Three people each add a shape at the same moment, before syncing.
  const shapes = clients.map((c, i) => {
    const s = createShape("rect", i * 10, 0, boards[i].allocateZ());
    c.addShape(s);
    return s;
  });
  net.flush();
  const all = [...clients[0].shapes.values()];
  const order = (zs: Map<string, number>) =>
    all
      .map((s) => ({ id: s.id, z: zs.get(s.id) ?? s.zIndex }))
      .sort((x, y) => x.z - y.z)
      .map((s) => s.id);
  const start = order(new Map());
  const bottom = new Set([start[0]]);
  const moved = order(reorderZ(all, bottom, "forward"));
  assert.deepEqual(moved, [start[1], start[0], start[2]], "the bottom shape moved up exactly one place");
  void shapes;
});
