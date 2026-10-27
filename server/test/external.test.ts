import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import { createShape, SyncEngine, type ClientMessage, type ServerMessage } from "@liveboard/shared";
import { startApp, type App } from "../src/app.ts";
import { createPostgresStore, type Store } from "../src/store.ts";

// These need real services, so they only run when you point them at some:
//   TEST_DATABASE_URL=postgres://...   TEST_REDIS_URL=redis://...   npm test
const PG = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;

const apps: App[] = [];
const stores: Store[] = [];
const dirs: string[] = [];
after(async () => {
  for (const app of apps) await app.close().catch(() => {});
  for (const store of stores) await store.close().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "liveboard-ext-"));
  dirs.push(dir);
  return dir;
};

async function waitFor(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

class Client {
  readonly clientId = `client-${randomUUID().slice(0, 8)}`;
  readonly engine: SyncEngine;
  ws!: WebSocket;
  constructor(readonly room: string) {
    this.engine = new SyncEngine({
      clientId: this.clientId,
      send: (m) => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(m)),
    });
  }
  connect(port: number): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    return new Promise((resolve, reject) => {
      this.ws.on("error", reject);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === "sync" || msg.type === "op") this.engine.handle(msg);
        if (msg.type === "sync") resolve();
      });
      this.ws.on("open", () =>
        this.ws.send(
          JSON.stringify({
            type: "join",
            roomId: this.room,
            clientId: this.clientId,
            displayName: "t",
            lastSeq: this.engine.lastSeq,
          } satisfies ClientMessage),
        ),
      );
    });
  }
  settled = () => waitFor(() => this.engine.pendingCount === 0, "no unconfirmed ops");
}
const view = (c: Client) => JSON.stringify([...c.engine.shapes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)));

test("Postgres: operations and snapshots persist across a restart", { skip: !PG }, async () => {
  const room = `pg-${randomUUID().slice(0, 8)}`;
  const first = await startApp({ port: 0, dataDir: tmp(), databaseUrl: PG, quiet: true });
  assert.equal(first.store.kind, "postgres");
  const alice = new Client(room);
  await alice.connect(first.port);
  const note = createShape("text", 0, 0, 0);
  alice.engine.addShape(note);
  alice.engine.editText(note.id, "in postgres");
  const rect = createShape("rect", 0, 0, 1);
  alice.engine.addShape(rect);
  for (let i = 1; i <= 120; i++) alice.engine.setProps(rect.id, { x: i });
  await alice.settled();
  assert.ok((await first.store.latestSnapshot(room))!.atSeq > 0, "a snapshot was written");
  const before = view(alice);
  await first.close();

  const second = await startApp({ port: 0, dataDir: tmp(), databaseUrl: PG, quiet: true });
  apps.push(second);
  const bob = new Client(room);
  await bob.connect(second.port);
  assert.equal(view(bob), before);
  assert.equal(bob.engine.textOf(note.id), "in postgres");
});

test("Redis: two servers coordinate, and a dead primary is replaced", { skip: !REDIS }, async () => {
  const room = `redis-${randomUUID().slice(0, 8)}`;
  const dir = tmp();
  const timing = { primaryTtlMs: 800, tickMs: 150 };
  const store = PG ? await createPostgresStore(PG) : undefined;
  if (store) stores.push(store);
  const sqliteFile = join(dir, "shared.db");
  // Both servers open the same database and the same Redis.
  const A = await startApp({ port: 0, dataDir: dir, sqliteFile, store, redisUrl: REDIS, serverId: "A", timing, quiet: true });
  const B = await startApp({ port: 0, dataDir: dir, sqliteFile, store, redisUrl: REDIS, serverId: "B", timing, quiet: true });
  apps.push(A, B);
  assert.equal(A.bus.kind, "redis");

  const alice = new Client(room);
  const bob = new Client(room);
  await alice.connect(A.port);
  await bob.connect(B.port);
  const note = createShape("text", 0, 0, 0);
  alice.engine.addShape(note);
  await waitFor(() => bob.engine.shapes.has(note.id), "Bob to see the text box through Redis");
  alice.engine.editText(note.id, "via redis");
  bob.engine.editText(note.id, "via redis too");
  await alice.settled();
  await bob.settled();
  await waitFor(() => view(alice) === view(bob), "convergence across servers");
  assert.deepEqual([A.hub.stats().rooms[0].primary, B.hub.stats().rooms[0].primary].sort(), [false, true]);

  const primary = A.hub.stats().rooms[0].primary ? A : B;
  const survivor = primary === A ? B : A;
  const stranded = primary === A ? alice : bob;
  const staying = primary === A ? bob : alice;
  await primary.killAbruptly();
  await waitFor(() => survivor.hub.stats().rooms[0]?.primary === true, "the survivor to take over the lock");
  await stranded.connect(survivor.port);
  staying.engine.editText(note.id, staying.engine.textOf(note.id) + "!");
  staying.engine.resendPending();
  await alice.settled();
  await bob.settled();
  await waitFor(() => view(alice) === view(bob), "convergence after failover");
});
