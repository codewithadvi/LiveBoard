import assert from "node:assert/strict";
import { test } from "node:test";
import { RoomCore } from "../src/roomcore.ts";
import type { ClientBody, ClientOp } from "../src/protocol.ts";
import type { CrdtOp } from "../src/crdt.ts";

const NOW = 1_000_000;
const tag = (id = "u1") => ({ t: NOW, c: 0, id });
let seq = 0;
const op = (body: ClientBody, clientId = "u1"): ClientOp => ({ clientId, clientSeq: ++seq, body });
const crdt = (o: CrdtOp, clientId = "u1") => op({ kind: "crdt", op: o }, clientId);
const add = (id: string, props: object = {}): CrdtOp => ({ kind: "add", id, type: "rect", tag: tag(), props });
const room = () => new RoomCore(() => NOW);
const accepted = (r: RoomCore, o: ClientOp) => r.prepare(o).ok;

test("well-formed operations are accepted", () => {
  const r = room();
  assert.ok(accepted(r, crdt(add("s1", { x: 5, y: -20, width: 10, fill: "#4f7cff", stroke: "red", opacity: 0.5, strokeWidth: 2 }))));
  assert.equal(accepted(r, crdt({ kind: "set", id: "s1", props: { fill: "none", sneaky: 1 } as never, ts: tag() })), false, "unknown property name is rejected");
  assert.ok(accepted(r, crdt({ kind: "set", id: "s1", props: { points: [[0, 0], [1.5, -2]], rotation: 3.14 }, ts: tag() })));
});

test("values that would break other people's screens are rejected", () => {
  const r = room();
  const bad: object[] = [
    { x: "oops" },
    { x: NaN },
    { x: Infinity },
    { x: 1e12 },
    { width: -5 },
    { opacity: 5 },
    { strokeWidth: 1e6 },
    { rotation: "1" },
    { fill: "url(javascript:alert(1))" },
    { fill: 'red"/><script>' },
    { stroke: 42 },
    { points: "abc" },
    { points: [] },
    { points: [[1]] },
    { points: [[1, "2"]] },
    { points: Array.from({ length: 5001 }, () => [0, 0]) },
    { notAProperty: 1 },
  ];
  for (const props of bad) {
    assert.equal(accepted(r, crdt({ kind: "set", id: "s1", props: props as never, ts: tag() })), false, JSON.stringify(props).slice(0, 60));
    assert.equal(accepted(r, crdt({ kind: "add", id: "s1", type: "rect", tag: tag(), props: props as never })), false, "add: " + JSON.stringify(props).slice(0, 60));
  }
});

test("structurally broken operations are rejected, not crashed on", () => {
  const r = room();
  const junk: unknown[] = [
    { kind: "crdt" },
    { kind: "crdt", op: null },
    { kind: "crdt", op: { kind: "add", id: "", type: "rect", tag: tag(), props: {} } },
    { kind: "crdt", op: { kind: "add", id: "s", type: "banana", tag: tag(), props: {} } },
    { kind: "crdt", op: { kind: "add", id: "s", type: "rect", tag: { t: "x" }, props: {} } },
    { kind: "crdt", op: { kind: "add", id: "s", type: "rect", tag: tag(), props: null } },
    { kind: "crdt", op: { kind: "remove", id: "s", tags: "all" } },
    { kind: "crdt", op: { kind: "remove", id: "s", tags: Array.from({ length: 500 }, () => tag()) } },
    { kind: "text", id: "s", rev: 0 },
    { kind: "nonsense" },
  ];
  for (const body of junk) assert.equal(accepted(r, op(body as ClientBody)), false, JSON.stringify(body).slice(0, 70));
});

test("a client cannot stamp operations with someone else's identity or a far-future clock", () => {
  const r = room();
  assert.equal(accepted(r, crdt({ kind: "add", id: "s", type: "rect", tag: tag("victim"), props: {} }, "mallory")), false);
  assert.equal(accepted(r, crdt({ kind: "add", id: "s", type: "rect", tag: { t: NOW + 3_600_000, c: 0, id: "u1" }, props: {} })), false);
});

test("text operations are checked: unknown types, huge documents, missing shapes", () => {
  const r = room();
  const commit = (o: ClientOp) => {
    const p = r.prepare(o);
    assert.ok(p.ok);
    r.commit({ ...o, body: (p as { body: ClientBody }).body, serverSeq: ++seq });
  };
  commit(crdt({ kind: "add", id: "t", type: "text", tag: tag(), props: {} }));

  const text = (rev: number, o: object) => op({ kind: "text", id: "t", rev, op: { clientId: "u1", ...o } as never });
  assert.equal(accepted(r, text(0, { type: "explode", index: 0 })), false, "unknown op type");
  assert.equal(accepted(r, text(0, { type: "insert", index: 0, char: "ab" })), false, "two characters");
  assert.equal(accepted(r, text(0, { type: "insert", index: 5, char: "a" })), false, "past the end");
  assert.equal(accepted(r, text(0, { type: "delete", index: 0 })), false, "delete from empty text");
  assert.equal(accepted(r, op({ kind: "text", id: "missing", rev: 0, op: { type: "insert", index: 0, char: "a", clientId: "u1" } })), false);

  for (let i = 0; i < 20_000; i++) commit(text(i, { type: "insert", index: i, char: "x" }));
  assert.equal(accepted(r, text(20_000, { type: "insert", index: 20_000, char: "x" })), false, "document size is capped");
  assert.equal(accepted(r, text(20_000, { type: "delete", index: 0 })), true, "but deleting is always allowed");
});

test("a board holds at most 10,000 shapes", () => {
  const r = room();
  for (let i = 0; i < 10_000; i++) {
    const o = crdt(add(`s${i}`));
    r.commit({ ...o, serverSeq: ++seq });
  }
  assert.equal(accepted(r, crdt(add("one-too-many"))), false);
  assert.ok(accepted(r, crdt(add("s5"))), "re-adding an existing shape is fine");
});
