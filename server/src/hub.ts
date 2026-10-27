import { RoomCore } from "@liveboard/shared";
import { REACTIONS } from "@liveboard/shared";
import type {
  ClientMessage,
  ClientOp,
  PresenceUser,
  SequencedOp,
  ServerMessage,
} from "@liveboard/shared";
import type { WebSocket } from "ws";
import type { AuthService } from "./auth";
import type { Bus } from "./bus";
import type { Store } from "./store";

const SNAPSHOT_EVERY = 100;
const MAX_SYNC_OPS = 5000;
const DEFAULT_PRIMARY_TTL_MS = 6000;
const DEFAULT_TICK_MS = 2000;
const PRESENCE_TTL_MS = 10_000;
const IDLE_CLOSE_MS = 30_000;
// A person dragging sends ~30-60 ops a second; this allows far more than that
// per tick but stops a runaway or hostile client from flooding a room.
const OPS_PER_TICK = 1000;
const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080", "#9a6324", "#800000", "#808000", "#000075"];

interface Conn {
  ws: WebSocket;
  roomId?: string;
  clientId?: string;
  user?: PresenceUser;
  userId?: string;
  syncing: boolean;
  backlog: SequencedOp[];
  cursorBudget: number;
  reactBudget: number;
  opBudget: number;
  warnedRate: boolean;
}

// The room's authoritative state, held only by the one server that is
// currently its primary. Every operation for the room is sequenced here.
class Primary {
  core!: RoomCore;
  private chain: Promise<void> = Promise.resolve();
  private sinceSnapshot = 0;
  stopped = false;
  unsubscribe: () => void = () => {};

  constructor(
    readonly roomId: string,
    private store: Store,
    private bus: Bus,
    private log: (m: string) => void,
  ) {}

  // Rebuild from the saved log: newest snapshot, then every op after it.
  async load(): Promise<void> {
    const snapshot = await this.store.latestSnapshot(this.roomId);
    const core = snapshot ? RoomCore.fromSnapshot(snapshot) : new RoomCore();
    for (const stored of await this.store.opsSince(this.roomId, core.seq, Number.MAX_SAFE_INTEGER)) {
      core.commit({ ...stored });
      this.sinceSnapshot++;
    }
    for (const [client, seq] of await this.store.maxClientSeqs(this.roomId)) core.setLastClientSeq(client, seq);
    this.core = core;
  }

  // One op at a time, in arrival order, so the global order is well defined.
  submit(op: ClientOp): Promise<string | undefined> {
    const result = this.chain.then(() => this.process(op));
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async process(op: ClientOp): Promise<string | undefined> {
    if (this.stopped) return "primary-stopped";
    const prepared = this.core.prepare(op);
    if (!prepared.ok) return prepared.reason === "duplicate" ? undefined : prepared.reason;

    // Save first, announce second: nothing is broadcast that is not durable.
    const serverSeq = await this.store.appendOp(this.roomId, op.clientId, op.clientSeq, prepared.body);
    const sop: SequencedOp = { clientId: op.clientId, clientSeq: op.clientSeq, body: prepared.body, serverSeq };
    this.core.commit(sop);
    await this.bus.publish(`out:${this.roomId}`, JSON.stringify(sop));

    if (++this.sinceSnapshot >= SNAPSHOT_EVERY) {
      this.sinceSnapshot = 0;
      await this.store.saveSnapshot(this.roomId, this.core.snapshot()).catch((e) => this.log(`snapshot failed: ${e}`));
    }
    return undefined;
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
  }
}

interface RoomRuntime {
  id: string;
  conns: Set<Conn>;
  primary?: Primary;
  unsubs: (() => void)[];
  remoteUsers: Map<string, { users: PresenceUser[]; seen: number }>;
  idleSince?: number;
  ready: Promise<void>;
}

// Everything the server does for connected browsers: join, sequence and
// broadcast operations, presence, and picking a primary per room.
export class Hub {
  private rooms = new Map<string, RoomRuntime>();
  private timer?: NodeJS.Timeout;

  constructor(
    readonly serverId: string,
    private store: Store,
    private bus: Bus,
    private auth: AuthService,
    private log: (m: string) => void = console.log,
    private timing: { primaryTtlMs: number; tickMs: number } = { primaryTtlMs: DEFAULT_PRIMARY_TTL_MS, tickMs: DEFAULT_TICK_MS },
  ) {
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`tick failed: ${e}`)), timing.tickMs);
    this.timer.unref();
  }

  stats() {
    return {
      serverId: this.serverId,
      rooms: [...this.rooms.values()].map((r) => ({ id: r.id, clients: r.conns.size, primary: !!r.primary })),
    };
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const rt of [...this.rooms.values()]) await this.closeRuntime(rt);
  }

  // Simulates a crash for tests: stop all activity without releasing locks.
  async crash(): Promise<void> {
    clearInterval(this.timer);
    for (const rt of this.rooms.values()) {
      rt.primary?.stop();
      for (const off of rt.unsubs) off();
    }
    this.rooms.clear();
  }

  // ---- connection lifecycle ----------------------------------------------------

  connect(ws: WebSocket): void {
    const conn: Conn = { ws, syncing: false, backlog: [], cursorBudget: 60, reactBudget: 10, opBudget: OPS_PER_TICK, warnedRate: false };
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return this.send(conn, { type: "error", code: "bad-message", message: "Not valid JSON." });
      }
      void this.onMessage(conn, msg).catch((e) => {
        this.log(`error handling ${msg?.type}: ${e}`);
        this.send(conn, { type: "error", code: "server-error", message: "Something went wrong on the server." });
      });
    });
    ws.on("close", () => void this.disconnect(conn));
    ws.on("error", () => {});
  }

  private async disconnect(conn: Conn): Promise<void> {
    const rt = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!rt || !rt.conns.delete(conn)) return;
    await this.publishPresence(rt);
    this.broadcastPresence(rt);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private async onMessage(conn: Conn, msg: ClientMessage): Promise<void> {
    if (msg.type === "join") return this.join(conn, msg);
    const rt = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!rt || !conn.clientId) return this.send(conn, { type: "error", code: "not-joined", message: "Join a room first." });

    if (msg.type === "op") {
      if (msg.op.clientId !== conn.clientId) {
        return this.send(conn, { type: "error", code: "bad-client", message: "Operation is not from this client." });
      }
      if (conn.opBudget-- <= 0) {
        if (!conn.warnedRate) {
          conn.warnedRate = true;
          this.send(conn, { type: "error", code: "rate-limited", message: "Slow down: too many changes at once." });
        }
        return;
      }
      return this.routeOp(rt, msg.op);
    }
    if (msg.type === "cursor") {
      if (conn.cursorBudget-- <= 0 || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
      await this.bus.publish(
        `cur:${rt.id}`,
        JSON.stringify({ clientId: conn.clientId, x: msg.x, y: msg.y, laser: msg.laser === true }),
      );
    }
    if (msg.type === "react") {
      // Only emoji from the fixed list, and only a few a second.
      if (conn.reactBudget-- <= 0 || !(REACTIONS as readonly string[]).includes(msg.emoji)) return;
      await this.bus.publish(`cur:${rt.id}`, JSON.stringify({ clientId: conn.clientId, emoji: msg.emoji }));
    }
  }

  // ---- joining -------------------------------------------------------------------

  private async join(conn: Conn, msg: Extract<ClientMessage, { type: "join" }>): Promise<void> {
    const roomId = String(msg.roomId ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
      return this.send(conn, { type: "error", code: "bad-room", message: "Board names use letters, numbers, - and _." });
    }
    if (typeof msg.clientId !== "string" || msg.clientId.length < 8 || msg.clientId.length > 64) {
      return this.send(conn, { type: "error", code: "bad-client", message: "Invalid client id." });
    }
    if (conn.roomId) return; // already joined

    const account = this.auth.verify(msg.token);
    const displayName = (String(msg.displayName ?? "").trim() || account?.displayName || "Guest").slice(0, 32);

    let room = await this.store.getRoom(roomId);
    if (!room) {
      const hash = msg.password ? await this.auth.hashPassword(msg.password) : null;
      await this.store.createRoom(roomId, hash, account?.userId ?? null);
      room = { id: roomId, passwordHash: hash, ownerId: account?.userId ?? null };
    } else if (room.passwordHash) {
      const ok = msg.password ? await this.auth.checkPassword(msg.password, room.passwordHash) : false;
      if (!ok) {
        return this.send(conn, {
          type: "error",
          code: msg.password ? "bad-password" : "password-required",
          message: msg.password ? "Wrong password." : "This board needs a password.",
        });
      }
    }

    const rt = await this.runtime(roomId);
    conn.roomId = roomId;
    conn.clientId = msg.clientId;
    conn.userId = account?.userId;
    conn.user = {
      clientId: msg.clientId,
      displayName,
      color: COLORS[[...msg.clientId].reduce((n, ch) => n + ch.charCodeAt(0), 0) % COLORS.length],
    };
    conn.syncing = true;
    rt.conns.add(conn);
    rt.idleSince = undefined;

    const sync = await this.buildSync(rt, msg.lastSeq || 0, conn.user);
    this.send(conn, sync);
    // Anything broadcast while we were building the sync is delivered now,
    // except what the sync already contained.
    conn.syncing = false;
    for (const sop of conn.backlog) if (sop.serverSeq > sync.seq) this.send(conn, { type: "op", sop });
    conn.backlog = [];

    await this.publishPresence(rt);
    this.broadcastPresence(rt);
  }

  private async buildSync(rt: RoomRuntime, lastSeq: number, you: PresenceUser): Promise<Extract<ServerMessage, { type: "sync" }>> {
    if (lastSeq > 0) {
      const ops = await this.store.opsSince(rt.id, lastSeq, MAX_SYNC_OPS + 1);
      if (ops.length <= MAX_SYNC_OPS) {
        const seq = ops.length ? ops[ops.length - 1].serverSeq : lastSeq;
        return { type: "sync", ops, seq, you };
      }
    }
    // New client (or one too far behind): send the whole state.
    const core = rt.primary?.core ?? (await this.loadCore(rt.id));
    const snapshot = core.snapshot();
    return { type: "sync", snapshot, ops: [], seq: snapshot.atSeq, you };
  }

  private async loadCore(roomId: string): Promise<RoomCore> {
    const p = new Primary(roomId, this.store, this.bus, this.log);
    await p.load();
    return p.core;
  }

  // ---- operations ----------------------------------------------------------------

  private async routeOp(rt: RoomRuntime, op: ClientOp): Promise<void> {
    if (rt.primary) {
      await this.reportProblem(rt.id, op.clientId, await rt.primary.submit(op));
      return;
    }
    // Another server owns this room: hand it the op over the bus.
    await this.bus.publish(`in:${rt.id}`, JSON.stringify(op));
  }

  // An op the primary refused (other than a harmless duplicate) is reported to
  // the client that sent it, wherever that client is connected, so it can
  // recover by re-syncing instead of waiting forever.
  private async reportProblem(roomId: string, clientId: string, problem: string | undefined): Promise<void> {
    if (!problem) return;
    this.log(`rejected op from ${clientId} in ${roomId}: ${problem}`);
    await this.bus.publish(`err:${roomId}`, JSON.stringify({ clientId, code: problem }));
  }

  // ---- per-room runtime ------------------------------------------------------------

  private runtime(roomId: string): Promise<RoomRuntime> {
    let rt = this.rooms.get(roomId);
    if (!rt) {
      rt = { id: roomId, conns: new Set(), unsubs: [], remoteUsers: new Map(), ready: Promise.resolve() };
      this.rooms.set(roomId, rt);
      const created = rt;
      created.ready = this.start(created).catch((e) => {
        this.rooms.delete(roomId); // let the next join try again from scratch
        throw e;
      });
    }
    return rt.ready.then(() => rt!);
  }

  private async start(rt: RoomRuntime): Promise<void> {
    const id = rt.id;
    rt.unsubs.push(
      await this.bus.subscribe(`out:${id}`, (raw) => {
        const sop = JSON.parse(raw) as SequencedOp;
        // Serialize once, send the same text to everyone in the room.
        const frame = `{"type":"op","sop":${raw}}`;
        for (const conn of rt.conns) {
          if (conn.syncing) conn.backlog.push(sop);
          else if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(frame);
        }
      }),
      await this.bus.subscribe(`err:${id}`, (raw) => {
        const e = JSON.parse(raw) as { clientId: string; code: string };
        for (const conn of rt.conns) {
          if (conn.clientId === e.clientId) {
            this.send(conn, { type: "error", code: "rejected", message: `The server rejected an operation (${e.code}).` });
          }
        }
      }),
      await this.bus.subscribe(`cur:${id}`, (raw) => {
        const c = JSON.parse(raw) as { clientId: string; x?: number; y?: number; laser?: boolean; emoji?: string };
        for (const conn of rt.conns) {
          if (conn.clientId === c.clientId || conn.syncing) continue;
          if (c.emoji) this.send(conn, { type: "reaction", clientId: c.clientId, emoji: c.emoji });
          else this.send(conn, { type: "cursor", clientId: c.clientId, x: c.x ?? 0, y: c.y ?? 0, laser: c.laser });
        }
      }),
      await this.bus.subscribe(`pres:${id}`, (raw) => {
        const p = JSON.parse(raw) as { from: string; users: PresenceUser[] };
        if (p.from === this.serverId) return;
        rt.remoteUsers.set(p.from, { users: p.users, seen: Date.now() });
        this.broadcastPresence(rt);
      }),
    );
    await this.tryBecomePrimary(rt);
  }

  private async tryBecomePrimary(rt: RoomRuntime): Promise<void> {
    if (rt.primary) return;
    if (!(await this.bus.claim(`primary:${rt.id}`, this.serverId, this.timing.primaryTtlMs))) return;
    const primary = new Primary(rt.id, this.store, this.bus, this.log);
    try {
      await primary.load();
    } catch (e) {
      await this.bus.release(`primary:${rt.id}`, this.serverId);
      throw e;
    }
    primary.unsubscribe = await this.bus.subscribe(`in:${rt.id}`, (raw) => {
      const op = JSON.parse(raw) as ClientOp;
      void primary.submit(op).then((problem) => this.reportProblem(rt.id, op.clientId, problem));
    });
    rt.primary = primary;
    this.log(`[${this.serverId}] primary for room ${rt.id} (seq ${primary.core.seq})`);
  }

  private async stepDown(rt: RoomRuntime): Promise<void> {
    if (!rt.primary) return;
    rt.primary.stop();
    rt.primary = undefined;
    await this.bus.release(`primary:${rt.id}`, this.serverId);
    this.log(`[${this.serverId}] stepped down for room ${rt.id}`);
  }

  private async closeRuntime(rt: RoomRuntime): Promise<void> {
    await this.stepDown(rt);
    for (const off of rt.unsubs) off();
    this.rooms.delete(rt.id);
  }

  // Housekeeping, every couple of seconds: keep the primary lock alive, take
  // over rooms whose primary has vanished, refresh presence, close idle rooms.
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const rt of [...this.rooms.values()]) {
      await rt.ready.catch(() => {});
      for (const conn of rt.conns) {
        conn.cursorBudget = 60;
        conn.reactBudget = 10;
        conn.opBudget = OPS_PER_TICK;
        conn.warnedRate = false;
      }

      if (rt.primary) {
        const stillMine = await this.bus.renew(`primary:${rt.id}`, this.serverId, this.timing.primaryTtlMs).catch(() => false);
        if (!stillMine) await this.stepDown(rt);
      } else {
        await this.tryBecomePrimary(rt).catch((e) => this.log(`takeover of ${rt.id} failed: ${e}`));
      }

      for (const [server, entry] of rt.remoteUsers) {
        if (now - entry.seen > PRESENCE_TTL_MS) {
          rt.remoteUsers.delete(server);
          this.broadcastPresence(rt);
        }
      }
      if (rt.conns.size > 0) await this.publishPresence(rt);

      const idle = rt.conns.size === 0 && rt.remoteUsers.size === 0;
      if (!idle) rt.idleSince = undefined;
      else if (rt.idleSince === undefined) rt.idleSince = now;
      else if (now - rt.idleSince > IDLE_CLOSE_MS) await this.closeRuntime(rt);
    }
  }

  // ---- presence ------------------------------------------------------------------------

  private localUsers(rt: RoomRuntime): PresenceUser[] {
    return [...rt.conns].filter((c) => c.user).map((c) => c.user!);
  }

  private async publishPresence(rt: RoomRuntime): Promise<void> {
    await this.bus.publish(`pres:${rt.id}`, JSON.stringify({ from: this.serverId, users: this.localUsers(rt) }));
  }

  private broadcastPresence(rt: RoomRuntime): void {
    const users = [...this.localUsers(rt), ...[...rt.remoteUsers.values()].flatMap((e) => e.users)];
    for (const conn of rt.conns) if (!conn.syncing) this.send(conn, { type: "presence", users });
  }
}
