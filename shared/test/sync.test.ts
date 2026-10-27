import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncEngine } from "../src/engine.ts";
import type { ClientMessage, ClientOp, ServerMessage } from "../src/protocol.ts";
import { RoomCore } from "../src/roomcore.ts";
import { createShape } from "../src/shapes.ts";
import { rng } from "./helpers.ts";

// A tiny in-memory network. Each direction of each connection is a FIFO queue
// (like a WebSocket), but the order in which queues are served is random, so
// messages from different users interleave arbitrarily.
class Sim {
  core = new RoomCore();
  seq = 0;
  engines: SyncEngine[] = [];
  toServer: ClientOp[][] = [];
  toClient: ServerMessage[][] = [];
  desyncs: string[] = [];
  rejected: string[] = [];
  seqCounter = 0;

  constructor(users: number) {
    for (let i = 0; i < users; i++) {
      this.toServer.push([]);
      this.toClient.push([]);
      this.engines.push(
        new SyncEngine({
          clientId: `c${i}`,
          send: (m: ClientMessage) => {
            if (m.type === "op") this.toServer[i].push(structuredClone(m.op));
          },
          now: () => 1_000 + this.seqCounter,
          onDesync: (why) => this.desyncs.push(`c${i}: ${why}`),
        }),
      );
    }
  }

  // Server handles one message from client i.
  serverStep(i: number): void {
    const op = this.toServer[i].shift()!;
    const prepared = this.core.prepare(op);
    if (!prepared.ok) {
      if (prepared.reason !== "duplicate") this.rejected.push(`${prepared.reason}: ${JSON.stringify(op)}`);
      return;
    }
    const sop = { ...op, body: prepared.body, serverSeq: ++this.seq };
    this.core.commit(sop);
    for (const q of this.toClient) q.push({ type: "op", sop: structuredClone(sop) });
  }

  clientStep(i: number): void {
    this.engines[i].handle(this.toClient[i].shift()!);
  }

  drain(r: ReturnType<typeof rng>): void {
    for (;;) {
      const moves: (() => void)[] = [];
      this.toServer.forEach((q, i) => q.length && moves.push(() => this.serverStep(i)));
      this.toClient.forEach((q, i) => q.length && moves.push(() => this.clientStep(i)));
      if (moves.length === 0) return;
      r.pick(moves)();
    }
  }
}

function randomEdit(sim: Sim, i: number, r: ReturnType<typeof rng>): void {
  const e = sim.engines[i];
  const shapes = [...e.shapes.values()];
  const texts = shapes.filter((s) => s.type === "text");
  const roll = r.next();

  if (roll < 0.12 || shapes.length === 0) {
    // Few ids, so users collide on the same shapes. Like real UUIDs, an id
    // always means the same kind of shape.
    const n = r.int(6);
    const s = createShape(n % 2 ? "text" : "rect", r.int(200), r.int(200), r.int(5));
    s.id = `shape-${n}`;
    if (!e.shapes.has(s.id)) e.addShape(s);
  } else if (roll < 0.45) {
    const s = r.pick(shapes);
    e.setProps(s.id, r.chance(0.5) ? { x: r.int(300) } : { y: r.int(300), width: r.int(100) });
  } else if (roll < 0.52) {
    e.removeShape(r.pick(shapes).id);
  } else if (roll < 0.58) {
    const dead = Object.keys(e.doc.shapes).filter((id) => !e.shapes.has(id));
    if (dead.length) e.restoreShape(r.pick(dead));
  } else if (texts.length && r.chance(0.2)) {
    // Undo / redo mixed in with everything else: these are ordinary edits and
    // must converge like any other.
    const s = r.pick(texts);
    if (r.chance(0.6)) e.undoText(s.id);
    else e.redoText(s.id);
  } else if (texts.length) {
    const s = r.pick(texts);
    const old = e.textOf(s.id);
    let next = old;
    for (let k = 0, n = 1 + r.int(3); k < n; k++) {
      if (next.length > 0 && r.chance(0.4)) {
        const at = r.int(next.length);
        next = next.slice(0, at) + next.slice(at + 1 + r.int(2));
      } else {
        const at = r.int(next.length + 1);
        next = next.slice(0, at) + r.pick(["a", "b", "c", "xy", "Z"]) + next.slice(at);
      }
    }
    e.editText(s.id, next);
  }
}

function snapshotOfView(e: SyncEngine) {
  return JSON.stringify(
    [...e.shapes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

test("fuzz: many users, random edits, random network interleaving: everyone converges", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const sim = new Sim(2 + r.int(3));
    for (let step = 0; step < 250; step++) {
      sim.seqCounter++;
      if (r.chance(0.55)) randomEdit(sim, r.int(sim.engines.length), r);
      else {
        // let one random channel make progress
        const i = r.int(sim.engines.length);
        if (r.chance(0.5) && sim.toServer[i].length) sim.serverStep(i);
        else if (sim.toClient[i].length) sim.clientStep(i);
      }
    }
    sim.drain(r);

    assert.deepEqual(sim.desyncs, [], `seed ${seed}: text revisions drifted`);
    assert.deepEqual(sim.rejected, [], `seed ${seed}: server rejected an op`);

    const views = sim.engines.map(snapshotOfView);
    for (let i = 1; i < views.length; i++) assert.equal(views[i], views[0], `seed ${seed}: client ${i} differs from client 0`);

    // The server's own copy must match too.
    const serverEngine = new SyncEngine({ clientId: "check", send: () => {} });
    serverEngine.doc = structuredClone(sim.core.doc);
    serverEngine.handle({ type: "sync", ops: [], seq: 0, you: { clientId: "x", displayName: "x", color: "x" } });
    assert.equal(snapshotOfView(serverEngine), views[0], `seed ${seed}: server differs from clients`);

    sim.engines.forEach((e, i) => assert.equal(e.pendingCount, 0, `seed ${seed}: client ${i} still has unconfirmed ops`));
  }
});

test("two users typing into the same text box at the same instant keep every character", () => {
  const sim = new Sim(2);
  const r = rng(1);
  const box = createShape("text", 0, 0, 0);
  sim.engines[0].addShape(box);
  sim.drain(r);

  sim.engines[0].editText(box.id, "Hello");
  sim.engines[1].editText(box.id, "World");
  sim.drain(r);

  const a = sim.engines[0].textOf(box.id);
  const b = sim.engines[1].textOf(box.id);
  assert.equal(a, b);
  assert.equal(a.length, 10);
  assert.deepEqual([...a].sort(), [..."HelloWorld"].sort());
  assert.deepEqual(sim.desyncs, []);
});
