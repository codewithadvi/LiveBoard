import {
  applyCrdt,
  emptyDoc,
  liveTags,
  materializeShape,
  type CrdtOp,
  type DocState,
} from "./crdt";
import { compareHLC, HLCClock, type HLC } from "./hlc";
import { applyText, diffToOps, TextClient, type TextOp } from "./ot";
import { TextUndo } from "./textundo";
import type {
  ClientBody,
  ClientMessage,
  SequencedOp,
  ServerMessage,
  Snapshot,
} from "./protocol";
import type { Shape, ShapeProps } from "./shapes";

export interface EngineOptions {
  clientId: string;
  send: (msg: ClientMessage) => void;
  now?: () => number;
  // Text boxes are sized from their content, which only the browser can measure.
  // Called with the text and the shape it belongs to (its font and size matter).
  measure?: (text: string, shape: Shape) => { width: number; height: number };
  onChange?: (ids: string[]) => void;
  // A remote text edit landed in this shape (lets an open editor move its caret).
  onRemoteText?: (id: string, op: TextOp) => void;
  onDesync?: (why: string) => void;
}

interface Pending {
  clientSeq: number;
  kind: "crdt" | "text";
  make: () => ClientBody;
}

// The client-side brain: holds the replica, applies local edits immediately
// (optimistic), tracks what the server has not confirmed yet, and folds in
// everyone else's operations. It has no DOM and no socket, so it can run in
// tests exactly as it runs in the browser.
export class SyncEngine {
  doc: DocState = emptyDoc();
  shapes = new Map<string, Shape>();
  lastSeq = 0;
  // Bumps whenever the visible shapes change, so views can cache cheaply.
  version = 0;
  readonly clock: HLCClock;

  private clientSeq = 0;
  private pending: Pending[] = [];
  private textClients = new Map<string, TextClient>();
  private textUndos = new Map<string, TextUndo>();

  constructor(private opts: EngineOptions) {
    this.clock = new HLCClock(opts.clientId, opts.now);
  }

  get clientId(): string {
    return this.opts.clientId;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  // ---- local edits ---------------------------------------------------------

  addShape(shape: Shape): void {
    const { id, type, text: _text, ...props } = shape;
    this.localCrdt({ kind: "add", id, type, tag: this.clock.tick(), props });
  }

  // Sends only the properties that actually differ, so two people changing
  // different properties of one shape never contend for the same register.
  // Returns the timestamp written, or undefined if nothing changed.
  setProps(id: string, props: ShapeProps): HLC | undefined {
    const current = this.shapes.get(id);
    if (!current) return undefined;
    const changed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined) continue;
      if (JSON.stringify((current as unknown as Record<string, unknown>)[name]) !== JSON.stringify(value)) {
        changed[name] = value;
      }
    }
    if (Object.keys(changed).length === 0) return undefined;
    const ts = this.clock.tick();
    this.localCrdt({ kind: "set", id, props: changed as ShapeProps, ts });
    return ts;
  }

  removeShape(id: string): void {
    const s = this.doc.shapes[id];
    if (!s) return;
    const tags = liveTags(s);
    if (tags.length) this.localCrdt({ kind: "remove", id, tags });
  }

  // Undo of a delete: a fresh add tag brings the shape back with the property
  // values it already had.
  restoreShape(id: string): void {
    const s = this.doc.shapes[id];
    if (!s?.type) return;
    this.localCrdt({ kind: "add", id, type: s.type, tag: this.clock.tick(), props: {} });
  }

  // When did the register for (id, prop) last change? Undo uses this to tell
  // whether anyone else has touched the value since.
  registerTs(id: string, prop: string): HLC | undefined {
    return this.doc.shapes[id]?.props[prop]?.ts;
  }

  editText(id: string, newText: string): void {
    const old = this.doc.texts[id]?.text ?? "";
    const ops = diffToOps(old, newText, this.opts.clientId);
    if (ops.length === 0) return;
    this.textUndoFor(id).record(old, ops, this.nowMs());
    this.applyLocalText(id, ops);
  }

  // Undo / redo the latest edit YOU made in this text box. Other people's
  // edits are never touched. Returns the operations applied (so an open editor
  // can place the caret), or null if there was nothing to undo.
  undoText(id: string): TextOp[] | null {
    const ops = this.textUndos.get(id)?.undo(this.textOf(id), this.nowMs());
    if (!ops) return null;
    this.applyLocalText(id, ops);
    return ops;
  }

  redoText(id: string): TextOp[] | null {
    const ops = this.textUndos.get(id)?.redo(this.textOf(id), this.nowMs());
    if (!ops) return null;
    this.applyLocalText(id, ops);
    return ops;
  }

  private applyLocalText(id: string, ops: TextOp[]): void {
    const tc = this.textClient(id, this.doc.texts[id]?.rev ?? 0);
    for (const op of ops) {
      this.writeText(id, op);
      tc.local(op);
    }
    this.refresh(id);
    this.opts.onChange?.([id]);
  }

  private textUndoFor(id: string): TextUndo {
    let undo = this.textUndos.get(id);
    if (!undo) this.textUndos.set(id, (undo = new TextUndo(this.opts.clientId)));
    return undo;
  }

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  textOf(id: string): string {
    return this.doc.texts[id]?.text ?? "";
  }

  private localCrdt(op: CrdtOp): void {
    applyCrdt(this.doc, op);
    this.refresh(op.id);
    this.opts.onChange?.([op.id]);
    this.enqueue("crdt", () => ({ kind: "crdt", op }));
  }

  private writeText(id: string, op: TextOp): void {
    const t = (this.doc.texts[id] ??= { text: "", rev: 0 });
    t.text = applyText(t.text, op);
  }

  private textClient(id: string, rev: number): TextClient {
    let tc = this.textClients.get(id);
    if (!tc) {
      tc = new TextClient(rev, () => {
        // Read the live state when (re)sending: the op may have been rewritten
        // by remote edits since it was first queued.
        const client = this.textClients.get(id)!;
        this.enqueue("text", () => ({ kind: "text", id, rev: client.rev, op: client.outstanding! }));
      });
      this.textClients.set(id, tc);
    }
    return tc;
  }

  // ---- talking to the server ----------------------------------------------

  private enqueue(kind: Pending["kind"], make: () => ClientBody): void {
    const entry: Pending = { clientSeq: ++this.clientSeq, kind, make };
    this.pending.push(entry);
    this.transmit(entry);
  }

  private transmit(entry: Pending): void {
    this.opts.send({
      type: "op",
      op: { clientId: this.opts.clientId, clientSeq: entry.clientSeq, body: entry.make() },
    });
  }

  // Send again everything the server has not confirmed. Safe to repeat: the
  // server drops duplicates by clientSeq, and CRDT ops are idempotent anyway.
  resendPending(): void {
    for (const entry of this.pending) this.transmit(entry);
  }

  handle(msg: ServerMessage): void {
    if (msg.type === "sync") {
      if (msg.snapshot) this.applySnapshot(msg.snapshot);
      for (const sop of msg.ops) this.applySequenced(sop);
      this.refreshAll();
      this.resendPending();
    } else if (msg.type === "op") {
      this.applySequenced(msg.sop);
    }
  }

  private applySnapshot(snap: Snapshot): void {
    this.doc = structuredClone(snap.doc);
    this.lastSeq = snap.atSeq;
    // Unconfirmed text edits cannot be replayed against a state we did not
    // build ourselves, so they are dropped. CRDT edits are re-applied below.
    this.textClients.clear();
    this.textUndos.clear(); // stored undo steps were written for text we no longer have
    this.pending = this.pending.filter((p) => p.kind === "crdt");
    let newest: HLC | undefined;
    for (const s of Object.values(this.doc.shapes)) {
      for (const reg of Object.values(s.props)) if (!newest || compareHLC(reg.ts, newest) > 0) newest = reg.ts;
      for (const tag of Object.values(s.adds)) if (!newest || compareHLC(tag, newest) > 0) newest = tag;
    }
    if (newest) this.clock.receive(newest);
    for (const p of this.pending) {
      const body = p.make();
      if (body.kind === "crdt") applyCrdt(this.doc, body.op);
    }
  }

  private applySequenced(sop: SequencedOp): void {
    if (sop.serverSeq <= this.lastSeq) return;
    this.lastSeq = sop.serverSeq;
    const own = sop.clientId === this.opts.clientId;

    if (own) {
      this.pending = this.pending.filter((p) => p.clientSeq !== sop.clientSeq);
      if (sop.body.kind === "text") {
        const tc = this.textClients.get(sop.body.id);
        if (tc) {
          if (tc.rev !== sop.body.rev) this.opts.onDesync?.(`own ack rev ${sop.body.rev} != ${tc.rev}`);
          tc.ack();
        }
      }
      return;
    }

    const body = sop.body;
    if (body.kind === "crdt") {
      const op = body.op;
      if (op.kind === "add") this.clock.receive(op.tag);
      if (op.kind === "set") this.clock.receive(op.ts);
      applyCrdt(this.doc, op);
      this.refresh(op.id);
      this.opts.onChange?.([op.id]);
      return;
    }

    const tc = this.textClient(body.id, body.rev);
    if (tc.rev !== body.rev) this.opts.onDesync?.(`remote rev ${body.rev} != ${tc.rev}`);
    const toApply = tc.remote(body.op);
    this.textUndos.get(body.id)?.remote(toApply); // keep my undo steps valid
    this.writeText(body.id, toApply);
    this.refresh(body.id);
    this.opts.onChange?.([body.id]);
    this.opts.onRemoteText?.(body.id, toApply);
  }

  // ---- view ------------------------------------------------------------------

  private refresh(id: string): void {
    this.version++;
    const shape = materializeShape(this.doc, id);
    if (!shape) {
      this.shapes.delete(id);
      return;
    }
    if (shape.type === "text" && this.opts.measure) Object.assign(shape, this.opts.measure(shape.text ?? "", shape));
    this.shapes.set(id, shape);
  }

  // Fonts load after the first frame; once they have, text must be measured again.
  remeasure(): void {
    this.refreshAll();
  }

  private refreshAll(): void {
    this.version++;
    const before = new Set(this.shapes.keys());
    this.shapes.clear();
    for (const id of Object.keys(this.doc.shapes)) this.refresh(id);
    const ids = new Set([...before, ...this.shapes.keys()]);
    this.opts.onChange?.([...ids]);
  }
}
