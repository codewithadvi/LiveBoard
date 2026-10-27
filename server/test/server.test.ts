import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import {
  createShape,
  SyncEngine,
  type ClientMessage,
  type PresenceUser,
  type ServerMessage,
} from "@liveboard/shared";
import { startApp, type App } from "../src/app.ts";
import { LocalBus } from "../src/bus.ts";
import { createSqliteStore } from "../src/store.ts";

const dirs: string[] = [];
const apps: App[] = [];
const sharedStores: { close(): Promise<void> }[] = [];
after(async () => {
  for (const app of apps) await app.close().catch(() => {});
  for (const store of sharedStores) await store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "liveboard-test-"));
  dirs.push(dir);
  return dir;
}

async function server(dataDir = tmp(), extra: Partial<Parameters<typeof startApp>[0]> = {}): Promise<App> {
  const app = await startApp({ port: 0, dataDir, quiet: true, ...extra });
  apps.push(app);
  return app;
}

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

// A headless browser: the real SyncEngine talking to a real server over a real socket.
class TestClient {
  readonly clientId = `client-${randomUUID().slice(0, 8)}`;
  readonly engine: SyncEngine;
  ws?: WebSocket;
  errors: { code: string; message: string }[] = [];
  presence: PresenceUser[] = [];
  cursors: { clientId: string; x: number; y: number; laser?: boolean }[] = [];
  reactions: { clientId: string; emoji: string }[] = [];
  sent: ClientMessage[] = [];

  constructor(
    readonly room: string,
    private opts: { name?: string; password?: string; token?: string } = {},
  ) {
    this.engine = new SyncEngine({
      clientId: this.clientId,
      send: (m) => {
        this.sent.push(m);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
      },
    });
  }

  async connect(port: number): Promise<"synced" | "error"> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === "error") {
          this.errors.push(msg);
          resolve("error");
        } else if (msg.type === "presence") this.presence = msg.users;
        else if (msg.type === "cursor") this.cursors.push(msg);
        else if (msg.type === "reaction") this.reactions.push(msg);
        else {
          this.engine.handle(msg);
          if (msg.type === "sync") resolve("synced");
        }
      });
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "join",
            roomId: this.room,
            clientId: this.clientId,
            displayName: this.opts.name ?? "tester",
            lastSeq: this.engine.lastSeq,
            password: this.opts.password,
            token: this.opts.token,
          } satisfies ClientMessage),
        ),
      );
    });
  }

  disconnect(): void {
    this.ws?.terminate();
  }

  async settled(): Promise<void> {
    await waitFor(() => this.engine.pendingCount === 0, `${this.clientId} to have no unconfirmed ops`);
  }
}

const view = (c: TestClient) =>
  JSON.stringify([...c.engine.shapes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));

async function converged(...clients: TestClient[]): Promise<void> {
  await Promise.all(clients.map((c) => c.settled()));
  await waitFor(() => clients.every((c) => view(c) === view(clients[0])), "all clients to show the same board");
}

// ---------------------------------------------------------------------------------

test("two clients through a real server converge, shapes and text", async () => {
  const app = await server();
  const alice = new TestClient("room-1", { name: "Alice" });
  const bob = new TestClient("room-1", { name: "Bob" });
  await alice.connect(app.port);
  await bob.connect(app.port);

  const box = createShape("rect", 10, 10, 0);
  alice.engine.addShape(box);
  const note = createShape("text", 0, 0, 1);
  alice.engine.addShape(note);
  await converged(alice, bob);

  alice.engine.setProps(box.id, { x: 500 }); // different properties, same instant
  bob.engine.setProps(box.id, { y: 700 });
  alice.engine.editText(note.id, "Hello");
  bob.engine.editText(note.id, "World");
  await converged(alice, bob);

  const shape = alice.engine.shapes.get(box.id)!;
  assert.equal(shape.x, 500);
  assert.equal(shape.y, 700);
  const text = alice.engine.textOf(note.id);
  assert.deepEqual([...text].sort(), [..."HelloWorld"].sort());
});

test("a client that joins late receives the whole board", async () => {
  const app = await server();
  const alice = new TestClient("late");
  await alice.connect(app.port);
  for (let i = 0; i < 5; i++) alice.engine.addShape(createShape("rect", i * 10, 0, i));
  const note = createShape("text", 0, 0, 9);
  alice.engine.addShape(note);
  alice.engine.editText(note.id, "already here");
  await alice.settled();

  const carol = new TestClient("late");
  await carol.connect(app.port);
  assert.equal(carol.engine.shapes.size, 6);
  assert.equal(carol.engine.textOf(note.id), "already here");
  await converged(alice, carol);
});

test("everything survives a full server restart", async () => {
  const dir = tmp();
  const first = await server(dir);
  const alice = new TestClient("persist");
  await alice.connect(first.port);
  const note = createShape("text", 0, 0, 0);
  alice.engine.addShape(note);
  alice.engine.editText(note.id, "saved to disk");
  const rect = createShape("rect", 1, 2, 1);
  alice.engine.addShape(rect);
  alice.engine.setProps(rect.id, { x: 99 });
  await alice.settled();
  const before = view(alice);
  await first.close();

  const second = await server(dir);
  const bob = new TestClient("persist");
  await bob.connect(second.port);
  assert.equal(view(bob), before);
  assert.equal(bob.engine.textOf(note.id), "saved to disk");

  // And the restarted server keeps sequencing correctly.
  bob.engine.editText(note.id, "saved to disk!");
  await bob.settled();
  assert.equal(bob.engine.textOf(note.id), "saved to disk!");
});

test("a snapshot is taken every 100 operations and used on restart", async () => {
  const dir = tmp();
  const first = await server(dir);
  const alice = new TestClient("snap");
  await alice.connect(first.port);
  const rect = createShape("rect", 0, 0, 0);
  alice.engine.addShape(rect);
  for (let i = 1; i <= 250; i++) alice.engine.setProps(rect.id, { x: i });
  await alice.settled();

  const snapshot = await first.store.latestSnapshot("snap");
  assert.ok(snapshot && snapshot.atSeq >= 200, `expected a snapshot near op 200, got ${snapshot?.atSeq}`);
  const before = view(alice);
  await first.close();

  const second = await server(dir);
  const bob = new TestClient("snap");
  await bob.connect(second.port);
  assert.equal(view(bob), before);
  assert.equal(bob.engine.shapes.get(rect.id)!.x, 250);
});

test("edits made offline are queued and replayed on reconnect", async () => {
  const app = await server();
  const alice = new TestClient("offline", { name: "Alice" });
  const bob = new TestClient("offline", { name: "Bob" });
  await alice.connect(app.port);
  await bob.connect(app.port);
  const rect = createShape("rect", 0, 0, 0);
  const note = createShape("text", 0, 0, 1);
  alice.engine.addShape(rect);
  alice.engine.addShape(note);
  alice.engine.editText(note.id, "start");
  await converged(alice, bob);

  alice.disconnect(); // Alice closes her laptop
  alice.engine.setProps(rect.id, { x: 111 });
  alice.engine.editText(note.id, "start-alice");
  assert.ok(alice.engine.pendingCount > 0, "offline edits are held, not lost");
  bob.engine.setProps(rect.id, { y: 222 });
  bob.engine.editText(note.id, "bob-start");
  await bob.settled();

  await alice.connect(app.port); // lastSeq tells the server what she missed
  await converged(alice, bob);
  const shape = bob.engine.shapes.get(rect.id)!;
  assert.equal(shape.x, 111);
  assert.equal(shape.y, 222);
  const text = bob.engine.textOf(note.id);
  assert.ok(text.includes("alice") && text.includes("bob"), `both edits survive, got "${text}"`);
});

test("replaying the saved log from scratch reproduces the live board exactly (no silent data loss)", async () => {
  const app = await server();
  const clients = [new TestClient("replay"), new TestClient("replay"), new TestClient("replay")];
  for (const c of clients) await c.connect(app.port);

  // 3 users make a few hundred random edits at the same time.
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const ids = ["a", "b", "c", "d"].map((n, i) => ({ id: `shape-${n}`, text: i % 2 === 1 }));
  for (const { id, text } of ids) {
    const s = createShape(text ? "text" : "rect", 0, 0, 0);
    s.id = id;
    clients[0].engine.addShape(s);
  }
  await converged(...clients);
  for (let i = 0; i < 300; i++) {
    const c = clients[rand(3)];
    const target = ids[rand(ids.length)];
    if (target.text) {
      const old = c.engine.textOf(target.id);
      const at = rand(old.length + 1);
      c.engine.editText(target.id, rand(3) === 0 && old.length ? old.slice(0, at) + old.slice(at + 1) : old.slice(0, at) + "xyz"[rand(3)] + old.slice(at));
    } else if (rand(10) === 0) c.engine.removeShape(target.id);
    else if (rand(10) === 0) c.engine.restoreShape(target.id);
    else c.engine.setProps(target.id, rand(2) ? { x: rand(500) } : { y: rand(500), width: rand(80) });
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 5)); // let some messages cross
  }
  await converged(...clients);

  // Rebuild the room from nothing but the saved log.
  const { RoomCore, canonical } = await import("@liveboard/shared");
  const log = await app.store.opsSince("replay", 0, 100_000);
  const rebuilt = new RoomCore();
  for (const stored of log) rebuilt.commit({ ...stored });

  const live = clients[0].engine.doc;
  assert.equal(canonical(rebuilt.doc), canonical(live), "shapes match");
  for (const { id, text } of ids) {
    if (text) assert.equal(rebuilt.doc.texts[id]?.text ?? "", live.texts[id]?.text ?? "", `text of ${id} matches`);
  }
  assert.ok(log.length > 100, `the log recorded the session (${log.length} operations)`);
});

test("a board with 500 operations is restored in well under 500 ms, new tab or returning tab", async () => {
  const app = await server();
  const author = new TestClient("fast-restore");
  await author.connect(app.port);
  const rect = createShape("rect", 0, 0, 0);
  author.engine.addShape(rect);
  const note = createShape("text", 0, 0, 1);
  author.engine.addShape(note);
  author.engine.editText(note.id, "x".repeat(100));
  for (let i = 0; i < 400; i++) author.engine.setProps(rect.id, { x: i + 1 });
  await author.settled();
  assert.ok((await app.store.opsSince("fast-restore", 0, 10_000)).length >= 500);

  const fresh = new TestClient("fast-restore");
  const t0 = performance.now();
  await fresh.connect(app.port);
  const newTab = performance.now() - t0;
  assert.equal(fresh.engine.shapes.get(rect.id)!.x, 400);

  // A client that was away only has to catch up on what it missed.
  const returning = new TestClient("fast-restore");
  await returning.connect(app.port);
  returning.disconnect();
  for (let i = 0; i < 50; i++) author.engine.setProps(rect.id, { y: i + 1 });
  await author.settled();
  const t1 = performance.now();
  await returning.connect(app.port);
  const resume = performance.now() - t1;
  assert.equal(returning.engine.shapes.get(rect.id)!.y, 50);

  assert.ok(newTab < 500, `new tab took ${newTab.toFixed(0)} ms`);
  assert.ok(resume < 500, `returning tab took ${resume.toFixed(0)} ms`);
  console.log(`      restore timings: new tab ${newTab.toFixed(0)} ms, returning tab ${resume.toFixed(0)} ms`);
});

test("a retransmitted operation is applied once", async () => {
  const app = await server();
  const alice = new TestClient("dups");
  await alice.connect(app.port);
  alice.engine.addShape(createShape("rect", 0, 0, 0));
  await alice.settled();
  const opsBefore = (await app.store.opsSince("dups", 0, 1000)).length;

  const original = alice.sent[0];
  alice.ws!.send(JSON.stringify(original));
  alice.ws!.send(JSON.stringify(original));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await app.store.opsSince("dups", 0, 1000)).length, opsBefore);
});

test("a client cannot send operations as someone else", async () => {
  const app = await server();
  const mallory = new TestClient("sec");
  await mallory.connect(app.port);
  mallory.engine.addShape(createShape("rect", 0, 0, 0));
  await mallory.settled();
  const forged = structuredClone(mallory.sent[0]) as Extract<ClientMessage, { type: "op" }>;
  forged.op.clientId = "someone-else-entirely";
  mallory.ws!.send(JSON.stringify(forged));
  await waitFor(() => mallory.errors.some((e) => e.code === "bad-client"), "a bad-client error");
});

test("an invalid operation is refused and reported", async () => {
  const app = await server();
  const c = new TestClient("invalid");
  await c.connect(app.port);
  c.ws!.send(
    JSON.stringify({
      type: "op",
      op: {
        clientId: c.clientId,
        clientSeq: 1,
        body: { kind: "text", id: "no-such-shape", rev: 0, op: { type: "insert", index: 0, char: "x", clientId: c.clientId } },
      },
    } satisfies ClientMessage),
  );
  await waitFor(() => c.errors.some((e) => e.code === "rejected"), "a rejected error");
  assert.equal((await app.store.opsSince("invalid", 0, 10)).length, 0, "nothing invalid reaches the log");
});

test("a flood of operations is rate limited, and bad values never reach the log", async () => {
  const app = await server(tmp(), { timing: { primaryTtlMs: 5000, tickMs: 60_000 } }); // budget won't refill mid-test
  const c = new TestClient("flood");
  await c.connect(app.port);
  const shape = createShape("rect", 0, 0, 0);
  c.engine.addShape(shape);
  await c.settled();

  // A hostile value, sent by hand around the engine.
  c.ws!.send(JSON.stringify({
    type: "op",
    op: {
      clientId: c.clientId,
      clientSeq: 9_000,
      body: { kind: "crdt", op: { kind: "set", id: shape.id, props: { x: "<img onerror=alert(1)>" }, ts: { t: Date.now(), c: 0, id: c.clientId } } },
    },
  } satisfies ClientMessage));
  await waitFor(() => c.errors.some((e) => e.code === "rejected"), "the bad value to be rejected");
  assert.equal(c.engine.shapes.get(shape.id)!.x, 0);

  for (let i = 1; i <= 1200; i++) c.engine.setProps(shape.id, { x: i });
  await waitFor(() => c.errors.some((e) => e.code === "rate-limited"), "a rate-limit warning");
  await new Promise((r) => setTimeout(r, 300));
  const saved = (await app.store.opsSince("flood", 0, 5000)).length;
  assert.ok(saved < 1100, `the flood was cut off (saved ${saved} of 1200)`);
});

test("password-protected boards", async () => {
  const app = await server();
  const owner = new TestClient("secret", { password: "hunter2hunter2" });
  assert.equal(await owner.connect(app.port), "synced"); // first visitor creates it

  const nopass = new TestClient("secret");
  assert.equal(await nopass.connect(app.port), "error");
  assert.equal(nopass.errors[0].code, "password-required");

  const wrong = new TestClient("secret", { password: "nope" });
  await wrong.connect(app.port);
  assert.equal(wrong.errors[0].code, "bad-password");

  const right = new TestClient("secret", { password: "hunter2hunter2" });
  assert.equal(await right.connect(app.port), "synced");
});

test("accounts: register, log in, own boards", async () => {
  const app = await server();
  const base = `http://127.0.0.1:${app.port}`;
  const post = (path: string, body: object) =>
    fetch(base + path, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, string> }));

  assert.equal((await post("/api/register", { email: "bad", password: "longenough1" })).status, 400);
  assert.equal((await post("/api/register", { email: "a@b.co", password: "short" })).status, 400);
  const reg = await post("/api/register", { email: "ada@example.com", password: "correct horse", displayName: "Ada" });
  assert.equal(reg.status, 200);
  assert.equal((await post("/api/register", { email: "ada@example.com", password: "correct horse" })).status, 400, "duplicate email");
  assert.equal((await post("/api/login", { email: "ada@example.com", password: "wrong password" })).status, 400);
  const login = await post("/api/login", { email: "ada@example.com", password: "correct horse" });
  assert.equal(login.status, 200);

  const ada = new TestClient("adas-board", { token: login.body.token });
  await ada.connect(app.port);
  const boards = await fetch(base + "/api/boards", { headers: { Authorization: `Bearer ${login.body.token}` } }).then((r) => r.json());
  assert.deepEqual((boards as { boards: { id: string }[] }).boards.map((b) => b.id), ["adas-board"]);
  assert.equal((await fetch(base + "/api/boards")).status, 401);
});

test("presence and cursors reach other users", async () => {
  const app = await server();
  const a = new TestClient("presence", { name: "Alice" });
  const b = new TestClient("presence", { name: "Bob" });
  await a.connect(app.port);
  await b.connect(app.port);
  await waitFor(() => a.presence.length === 2 && b.presence.length === 2, "both users in the list");
  assert.deepEqual(a.presence.map((u) => u.displayName).sort(), ["Alice", "Bob"]);

  b.ws!.send(JSON.stringify({ type: "cursor", x: 5, y: 6 } satisfies ClientMessage));
  await waitFor(() => a.cursors.length > 0, "Alice to see Bob's cursor");
  assert.deepEqual([a.cursors[0].x, a.cursors[0].y, a.cursors[0].clientId === b.clientId], [5, 6, true]);

  b.disconnect();
  await waitFor(() => a.presence.length === 1, "Bob to leave the list");
});

test("laser pointers and reactions reach others, but only from the allowed set", async () => {
  const app = await server();
  const a = new TestClient("fun", { name: "Alice" });
  const b = new TestClient("fun", { name: "Bob" });
  await a.connect(app.port);
  await b.connect(app.port);

  b.ws!.send(JSON.stringify({ type: "cursor", x: 10, y: 20, laser: true } satisfies ClientMessage));
  b.ws!.send(JSON.stringify({ type: "cursor", x: "nope", y: 1 }));
  b.ws!.send(JSON.stringify({ type: "cursor", x: Infinity, y: 1 }));
  b.ws!.send(JSON.stringify({ type: "react", emoji: "🎉" } satisfies ClientMessage));
  b.ws!.send(JSON.stringify({ type: "react", emoji: "<script>alert(1)</script>" }));
  b.ws!.send(JSON.stringify({ type: "react", emoji: "💩" }));
  await waitFor(() => a.reactions.length > 0 && a.cursors.length > 0, "the laser point and the reaction");
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(a.cursors.map((c) => [c.x, c.y, c.laser]), [[10, 20, true]], "bad coordinates were dropped");
  assert.deepEqual(a.reactions.map((r) => r.emoji), ["🎉"], "only the allowed emoji got through");
  assert.equal(a.reactions[0].clientId, b.clientId);
  assert.equal(b.reactions.length, 0, "you do not get your own reaction back");
});

test("two servers share a room; when the primary dies the other takes over with nothing lost", async () => {
  const dir = tmp();
  const store = await createSqliteStore(join(dir, "shared.db"));
  await store.init();
  sharedStores.push(store);
  const bus = new LocalBus();
  const timing = { primaryTtlMs: 500, tickMs: 100 };
  const A = await server(dir, { store, bus, serverId: "A", timing });
  const B = await server(dir, { store, bus, serverId: "B", timing });

  const alice = new TestClient("cluster", { name: "Alice" });
  const bob = new TestClient("cluster", { name: "Bob" });
  await alice.connect(A.port); // A becomes primary
  await bob.connect(B.port); //  B forwards through the bus

  const rect = createShape("rect", 0, 0, 0);
  const note = createShape("text", 0, 0, 1);
  alice.engine.addShape(rect);
  alice.engine.addShape(note);
  alice.engine.editText(note.id, "from A");
  await converged(alice, bob);
  bob.engine.setProps(rect.id, { x: 5 });
  await converged(alice, bob);
  assert.equal(A.hub.stats().rooms[0].primary, true);
  assert.equal(B.hub.stats().rooms[0].primary, false);

  await A.killAbruptly();
  alice.engine.setProps(rect.id, { y: 6 }); // sent into the void
  bob.engine.editText(note.id, "from A, B too");
  await waitFor(() => B.hub.stats().rooms[0]?.primary === true, "B to take over as primary");

  await alice.connect(B.port); // Alice reconnects to the survivor
  bob.engine.resendPending(); // the client's retry timer, done by hand
  await converged(alice, bob);
  assert.equal(bob.engine.shapes.get(rect.id)!.x, 5);
  assert.equal(bob.engine.shapes.get(rect.id)!.y, 6);
  assert.ok(bob.engine.textOf(note.id).includes("B too"));
});

test("with Redis unreachable the server keeps working in degraded single-node mode", async () => {
  const app = await server(tmp(), { redisUrl: "redis://127.0.0.1:1" });
  const a = new TestClient("degraded");
  const b = new TestClient("degraded");
  await a.connect(app.port);
  await b.connect(app.port);
  a.engine.addShape(createShape("rect", 1, 1, 0));
  await converged(a, b);
  assert.equal(b.engine.shapes.size, 1);
});
