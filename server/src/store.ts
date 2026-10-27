import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ClientBody, Snapshot } from "@liveboard/shared";

// Where operations and snapshots are saved. The operation log is the source of
// truth; everything held in memory is a cache that can be rebuilt from it.
// Two implementations: SQLite (default, nothing to install) and Postgres.

export interface StoredOp {
  serverSeq: number;
  clientId: string;
  clientSeq: number;
  body: ClientBody;
}

export interface RoomRecord {
  id: string;
  passwordHash: string | null;
  ownerId: string | null;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
}

export interface Store {
  readonly kind: "sqlite" | "postgres";
  init(): Promise<void>;
  close(): Promise<void>;

  getRoom(id: string): Promise<RoomRecord | undefined>;
  createRoom(id: string, passwordHash: string | null, ownerId: string | null): Promise<void>;
  roomsOwnedBy(ownerId: string): Promise<{ id: string; createdAt: string }[]>;

  // Saves the operation and returns the number the log gave it (its serverSeq).
  appendOp(roomId: string, clientId: string, clientSeq: number, body: ClientBody): Promise<number>;
  opsSince(roomId: string, afterSeq: number, limit: number): Promise<StoredOp[]>;
  latestSnapshot(roomId: string): Promise<Snapshot | undefined>;
  saveSnapshot(roomId: string, snapshot: Snapshot): Promise<void>;
  // Highest clientSeq ever saved per client: how a restarted server knows
  // which retransmitted operations it has already seen.
  maxClientSeqs(roomId: string): Promise<[string, number][]>;

  createUser(user: UserRecord): Promise<boolean>; // false if the email is taken
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
}

// ---- SQLite ------------------------------------------------------------------

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    password_hash TEXT, owner_id TEXT);
  CREATE TABLE IF NOT EXISTS operations (
    server_seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
    client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, op_type TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS ops_room_seq ON operations(room_id, server_seq);
  CREATE INDEX IF NOT EXISTS ops_room_client ON operations(room_id, client_id, client_seq);
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, at_seq INTEGER NOT NULL,
    state TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS snapshots_room ON snapshots(room_id, at_seq DESC);
`;

function opType(body: ClientBody): string {
  return body.kind === "crdt" ? `shape:${body.op.kind}` : "text";
}

export async function createSqliteStore(file: string): Promise<Store> {
  // Loaded lazily: node:sqlite prints an "experimental" warning on import.
  const { DatabaseSync } = await import("node:sqlite");
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  const store: Store = {
    kind: "sqlite",
    async init() {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(SQLITE_SCHEMA);
    },
    async close() {
      db.close();
    },
    async getRoom(id) {
      const row = db.prepare("SELECT id, password_hash, owner_id FROM rooms WHERE id = ?").get(id) as
        | { id: string; password_hash: string | null; owner_id: string | null }
        | undefined;
      return row && { id: row.id, passwordHash: row.password_hash, ownerId: row.owner_id };
    },
    async createRoom(id, passwordHash, ownerId) {
      db.prepare("INSERT OR IGNORE INTO rooms (id, password_hash, owner_id) VALUES (?, ?, ?)").run(
        id,
        passwordHash,
        ownerId,
      );
    },
    async roomsOwnedBy(ownerId) {
      const rows = db
        .prepare("SELECT id, created_at FROM rooms WHERE owner_id = ? ORDER BY created_at DESC")
        .all(ownerId) as { id: string; created_at: string }[];
      return rows.map((r) => ({ id: r.id, createdAt: r.created_at }));
    },
    async appendOp(roomId, clientId, clientSeq, body) {
      const res = db
        .prepare(
          "INSERT INTO operations (room_id, client_id, client_seq, op_type, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(roomId, clientId, clientSeq, opType(body), JSON.stringify(body));
      return Number(res.lastInsertRowid);
    },
    async opsSince(roomId, afterSeq, limit) {
      const rows = db
        .prepare(
          "SELECT server_seq, client_id, client_seq, payload FROM operations WHERE room_id = ? AND server_seq > ? ORDER BY server_seq LIMIT ?",
        )
        .all(roomId, afterSeq, limit) as {
        server_seq: number;
        client_id: string;
        client_seq: number;
        payload: string;
      }[];
      return rows.map((r) => ({
        serverSeq: r.server_seq,
        clientId: r.client_id,
        clientSeq: r.client_seq,
        body: JSON.parse(r.payload) as ClientBody,
      }));
    },
    async latestSnapshot(roomId) {
      const row = db
        .prepare("SELECT at_seq, state FROM snapshots WHERE room_id = ? ORDER BY at_seq DESC LIMIT 1")
        .get(roomId) as { at_seq: number; state: string } | undefined;
      return row && { atSeq: row.at_seq, doc: JSON.parse(row.state) };
    },
    async saveSnapshot(roomId, snapshot) {
      db.prepare("INSERT INTO snapshots (room_id, at_seq, state) VALUES (?, ?, ?)").run(
        roomId,
        snapshot.atSeq,
        JSON.stringify(snapshot.doc),
      );
    },
    async maxClientSeqs(roomId) {
      const rows = db
        .prepare("SELECT client_id, MAX(client_seq) AS m FROM operations WHERE room_id = ? GROUP BY client_id")
        .all(roomId) as { client_id: string; m: number }[];
      return rows.map((r): [string, number] => [r.client_id, r.m]);
    },
    async createUser(u) {
      try {
        db.prepare("INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)").run(
          u.id,
          u.email,
          u.displayName,
          u.passwordHash,
        );
        return true;
      } catch {
        return false;
      }
    },
    async findUserByEmail(email) {
      const row = db
        .prepare("SELECT id, email, display_name, password_hash FROM users WHERE email = ?")
        .get(email) as { id: string; email: string; display_name: string; password_hash: string } | undefined;
      return row && { id: row.id, email: row.email, displayName: row.display_name, passwordHash: row.password_hash };
    },
  };
  return store;
}

// ---- Postgres ------------------------------------------------------------------

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(),
    password_hash TEXT, owner_id TEXT);
  CREATE TABLE IF NOT EXISTS operations (
    server_seq BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL,
    client_id TEXT NOT NULL, client_seq INT NOT NULL, op_type TEXT NOT NULL,
    payload JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE INDEX IF NOT EXISTS ops_room_seq ON operations(room_id, server_seq);
  CREATE INDEX IF NOT EXISTS ops_room_client ON operations(room_id, client_id, client_seq);
  CREATE TABLE IF NOT EXISTS snapshots (
    id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL, at_seq BIGINT NOT NULL,
    state JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
  CREATE INDEX IF NOT EXISTS snapshots_room ON snapshots(room_id, at_seq DESC);
`;

export async function createPostgresStore(url: string): Promise<Store> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });

  const store: Store = {
    kind: "postgres",
    async init() {
      await pool.query(PG_SCHEMA);
    },
    async close() {
      await pool.end();
    },
    async getRoom(id) {
      const { rows } = await pool.query("SELECT id, password_hash, owner_id FROM rooms WHERE id = $1", [id]);
      const r = rows[0];
      return r && { id: r.id, passwordHash: r.password_hash, ownerId: r.owner_id };
    },
    async createRoom(id, passwordHash, ownerId) {
      await pool.query(
        "INSERT INTO rooms (id, password_hash, owner_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [id, passwordHash, ownerId],
      );
    },
    async roomsOwnedBy(ownerId) {
      const { rows } = await pool.query(
        "SELECT id, created_at FROM rooms WHERE owner_id = $1 ORDER BY created_at DESC",
        [ownerId],
      );
      return rows.map((r) => ({ id: r.id as string, createdAt: new Date(r.created_at).toISOString() }));
    },
    async appendOp(roomId, clientId, clientSeq, body) {
      const { rows } = await pool.query(
        "INSERT INTO operations (room_id, client_id, client_seq, op_type, payload) VALUES ($1, $2, $3, $4, $5) RETURNING server_seq",
        [roomId, clientId, clientSeq, opType(body), JSON.stringify(body)],
      );
      return Number(rows[0].server_seq);
    },
    async opsSince(roomId, afterSeq, limit) {
      const { rows } = await pool.query(
        "SELECT server_seq, client_id, client_seq, payload FROM operations WHERE room_id = $1 AND server_seq > $2 ORDER BY server_seq LIMIT $3",
        [roomId, afterSeq, limit],
      );
      return rows.map((r) => ({
        serverSeq: Number(r.server_seq),
        clientId: r.client_id as string,
        clientSeq: r.client_seq as number,
        body: r.payload as ClientBody,
      }));
    },
    async latestSnapshot(roomId) {
      const { rows } = await pool.query(
        "SELECT at_seq, state FROM snapshots WHERE room_id = $1 ORDER BY at_seq DESC LIMIT 1",
        [roomId],
      );
      const r = rows[0];
      return r && { atSeq: Number(r.at_seq), doc: r.state };
    },
    async saveSnapshot(roomId, snapshot) {
      await pool.query("INSERT INTO snapshots (room_id, at_seq, state) VALUES ($1, $2, $3)", [
        roomId,
        snapshot.atSeq,
        JSON.stringify(snapshot.doc),
      ]);
    },
    async maxClientSeqs(roomId) {
      const { rows } = await pool.query(
        "SELECT client_id, MAX(client_seq) AS m FROM operations WHERE room_id = $1 GROUP BY client_id",
        [roomId],
      );
      return rows.map((r): [string, number] => [r.client_id, Number(r.m)]);
    },
    async createUser(u) {
      const res = await pool.query(
        "INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [u.id, u.email, u.displayName, u.passwordHash],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async findUserByEmail(email) {
      const { rows } = await pool.query(
        "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
        [email],
      );
      const r = rows[0];
      return r && { id: r.id, email: r.email, displayName: r.display_name, passwordHash: r.password_hash };
    },
  };
  return store;
}

export async function createStore(opts: { databaseUrl?: string; sqliteFile: string }): Promise<Store> {
  return opts.databaseUrl ? createPostgresStore(opts.databaseUrl) : createSqliteStore(opts.sqliteFile);
}
