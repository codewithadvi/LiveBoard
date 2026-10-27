import { applyCrdt, emptyDoc, type DocState } from "./crdt";
import {
  newServerText,
  serverCommit,
  serverTransform,
  type ServerText,
} from "./ot";
import type { ClientBody, ClientOp, SequencedOp, Snapshot } from "./protocol";
import {
  MAX_SHAPES_PER_BOARD,
  MAX_TEXT_LENGTH,
  validHlc,
  validProps,
  validShapeId,
  validTags,
} from "./validate";

const SHAPE_TYPES = new Set(["rect", "circle", "arrow", "line", "path", "text"]);
const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;
const MAX_TEXT_HISTORY = 2000;

export type PrepareResult =
  | { ok: true; body: ClientBody }
  | { ok: false; reason: "duplicate" | "invalid" | "stale" };

// The pure, I/O-free half of a room on the server: it decides what an incoming
// operation means (validate, drop duplicates, transform text) and applies the
// result. The caller does persistence and broadcasting between prepare() and
// commit(), so nothing is announced that has not been saved.
export class RoomCore {
  doc: DocState = emptyDoc();
  seq = 0;
  private texts = new Map<string, ServerText>();
  private lastClientSeq = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  static fromSnapshot(snapshot: Snapshot, lastClientSeq: Iterable<[string, number]> = []): RoomCore {
    const core = new RoomCore();
    core.doc = structuredClone(snapshot.doc);
    core.seq = snapshot.atSeq;
    for (const [id, t] of Object.entries(core.doc.texts)) core.texts.set(id, newServerText(t.text, t.rev));
    for (const [client, seq] of lastClientSeq) core.lastClientSeq.set(client, seq);
    return core;
  }

  setLastClientSeq(clientId: string, seq: number): void {
    this.lastClientSeq.set(clientId, Math.max(seq, this.lastClientSeq.get(clientId) ?? 0));
  }

  snapshot(): Snapshot {
    return { atSeq: this.seq, doc: structuredClone(this.doc) };
  }

  // Check an operation and work out what will actually be applied.
  // Does not change any state.
  prepare(op: ClientOp): PrepareResult {
    if (op.clientSeq <= (this.lastClientSeq.get(op.clientId) ?? 0)) return { ok: false, reason: "duplicate" };
    const body = op.body;

    if (body.kind === "crdt") {
      const c = body.op;
      if (!c || !validShapeId(c.id)) return { ok: false, reason: "invalid" };
      if (c.kind === "add") {
        const isNew = !this.doc.shapes[c.id];
        if (
          !SHAPE_TYPES.has(c.type) ||
          !validHlc(c.tag) ||
          c.tag.id !== op.clientId ||
          !this.clockOk(c.tag.t) ||
          !validProps(c.props) ||
          (isNew && Object.keys(this.doc.shapes).length >= MAX_SHAPES_PER_BOARD)
        ) {
          return { ok: false, reason: "invalid" };
        }
      } else if (c.kind === "set") {
        if (!validHlc(c.ts) || c.ts.id !== op.clientId || !this.clockOk(c.ts.t) || !validProps(c.props)) {
          return { ok: false, reason: "invalid" };
        }
      } else if (c.kind !== "remove" || !validTags(c.tags)) {
        return { ok: false, reason: "invalid" };
      }
      return { ok: true, body };
    }

    if (body.kind === "text") {
      const shape = validShapeId(body.id) ? this.doc.shapes[body.id] : undefined;
      if (!shape || shape.type !== "text" || !body.op || body.op.clientId !== op.clientId) {
        return { ok: false, reason: "invalid" };
      }
      const text = this.texts.get(body.id) ?? newServerText();
      if (body.op.type === "insert" && text.text.length >= MAX_TEXT_LENGTH) return { ok: false, reason: "invalid" };
      const transformed = serverTransform(text, body.op, body.rev);
      if (!transformed) return { ok: false, reason: "stale" };
      return { ok: true, body: { kind: "text", id: body.id, rev: text.rev, op: transformed } };
    }

    return { ok: false, reason: "invalid" };
  }

  // Apply an operation that has already been prepared and saved.
  commit(sop: SequencedOp): void {
    this.seq = Math.max(this.seq, sop.serverSeq);
    this.lastClientSeq.set(sop.clientId, Math.max(sop.clientSeq, this.lastClientSeq.get(sop.clientId) ?? 0));
    const body = sop.body;
    if (body.kind === "crdt") {
      applyCrdt(this.doc, body.op);
      return;
    }
    let text = this.texts.get(body.id);
    if (!text) {
      text = newServerText();
      this.texts.set(body.id, text);
    }
    serverCommit(text, body.op);
    if (text.history.length > MAX_TEXT_HISTORY) {
      text.history.splice(0, MAX_TEXT_HISTORY / 2);
      text.baseRev += MAX_TEXT_HISTORY / 2;
    }
    this.doc.texts[body.id] = { text: text.text, rev: text.rev };
  }

  private clockOk(t: number): boolean {
    return t <= this.now() + MAX_CLOCK_DRIFT_MS;
  }
}
