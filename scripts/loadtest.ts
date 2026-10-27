// Load test: many simulated users in one board, all editing at once.
//   npm run loadtest                      (starts its own server)
//   npm run loadtest -- --users 50 --rate 10 --seconds 10
//   npm run loadtest -- --url ws://localhost:8080   (test a running server)
//
// Each user owns a shape and moves it `rate` times a second. Every update
// carries the moment it was made, so each OTHER user can measure how long it
// took to arrive: that is the "operation propagation latency" in the PRD.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createShape, SyncEngine, type ClientMessage, type ServerMessage } from "@liveboard/shared";
import { startApp } from "../server/src/app";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const users = arg("users", 50);
const rate = arg("rate", 10);
const seconds = arg("seconds", 10);
const urlIdx = process.argv.indexOf("--url");
let url = urlIdx > 0 ? process.argv[urlIdx + 1] : undefined;

const dir = mkdtempSync(join(tmpdir(), "liveboard-load-"));
const app = url ? undefined : await startApp({ port: 0, dataDir: dir, quiet: true });
url ??= `ws://127.0.0.1:${app!.port}`;
const room = `load-${Date.now().toString(36)}`;

interface Sim {
  engine: SyncEngine;
  ws: WebSocket;
  shapeId: string;
}
const latencies: number[] = [];
let received = 0;

async function connect(i: number): Promise<Sim> {
  const ws = new WebSocket(url!);
  const clientId = `load-user-${i}-${Math.random().toString(36).slice(2, 8)}`;
  const engine = new SyncEngine({
    clientId,
    send: (m: ClientMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
    // Updates from other users arrive here: the fill carries the send time.
    onChange: (ids) => {
      const now = performance.now();
      for (const id of ids) {
        const s = engine.shapes.get(id);
        if (!s || id === shape.id || !s.fill.startsWith("t:")) continue;
        latencies.push(now - Number(s.fill.slice(2)));
        received++;
      }
    },
  });
  const shape = createShape("rect", i * 10, 0, i);
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === "sync" || msg.type === "op") engine.handle(msg);
      if (msg.type === "sync") resolve();
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ type: "join", roomId: room, clientId, displayName: `u${i}`, lastSeq: 0 } satisfies ClientMessage),
      ),
    );
  });
  engine.addShape(shape);
  return { engine, ws, shapeId: shape.id };
}

console.log(`connecting ${users} users to ${url} ...`);
const sims = await Promise.all(Array.from({ length: users }, (_, i) => connect(i)));
await new Promise((r) => setTimeout(r, 500)); // let every shape reach everyone
latencies.length = 0;
received = 0;

console.log(`${users} users x ${rate} updates/s for ${seconds}s ...`);
let sent = 0;
const started = performance.now();
const timers = sims.map((sim, i) =>
  setInterval(() => {
    sim.engine.setProps(sim.shapeId, { x: Math.random() * 1000, fill: `t:${performance.now()}` });
    sent++;
  }, 1000 / rate + (i % 7)), // staggered so users don't all fire on the same tick
);
await new Promise((r) => setTimeout(r, seconds * 1000));
timers.forEach(clearInterval);
await new Promise((r) => setTimeout(r, 1000)); // let the tail arrive
const elapsed = (performance.now() - started) / 1000;

const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
const unconfirmed = sims.reduce((n, s) => n + s.engine.pendingCount, 0);

console.log(`\nsent ${sent} updates (${(sent / seconds).toFixed(0)}/s), ${received} deliveries to other users`);
console.log(`latency  p50 ${pct(50).toFixed(1)} ms   p95 ${pct(95).toFixed(1)} ms   p99 ${pct(99).toFixed(1)} ms   max ${pct(100).toFixed(1)} ms`);
console.log(`unconfirmed ops at the end: ${unconfirmed}  (elapsed ${elapsed.toFixed(1)}s)`);
console.log(
  `PRD targets (p50 < 80 ms, p99 < 200 ms, 50 users): ${pct(50) < 80 && pct(99) < 200 && users >= 50 ? "MET" : "NOT MET at this setting"}`,
);

for (const s of sims) s.ws.close();
await app?.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
