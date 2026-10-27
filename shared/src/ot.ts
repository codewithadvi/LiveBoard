// Operational Transformation for plain text, one character at a time.
//
// Positions shift when someone else edits, so an operation made against an
// older version of the text has to be rewritten before it is applied to a
// newer one. transformPair does that rewriting.

export type TextOp =
  | { type: "insert"; index: number; char: string; clientId: string }
  | { type: "delete"; index: number; clientId: string }
  | { type: "noop"; clientId: string };

export function applyText(text: string, op: TextOp): string {
  switch (op.type) {
    case "insert":
      return text.slice(0, op.index) + op.char + text.slice(op.index);
    case "delete":
      return text.slice(0, op.index) + text.slice(op.index + 1);
    case "noop":
      return text;
  }
}

// Is this op legal on a text of the given length?
export function isValidTextOp(op: TextOp, length: number): boolean {
  if (op.type === "insert") return Number.isInteger(op.index) && op.index >= 0 && op.index <= length && op.char.length === 1;
  if (op.type === "delete") return Number.isInteger(op.index) && op.index >= 0 && op.index < length;
  return op.type === "noop"; // anything else is not an operation we know
}

const noop = (clientId: string): TextOp => ({ type: "noop", clientId });

// Given two operations made concurrently against the same text, return
//   a' : `a` rewritten so it can be applied after `b`
//   b' : `b` rewritten so it can be applied after `a`
// such that   apply(apply(text, a), b') === apply(apply(text, b), a')
// That equality is the TP1 property, and it is what makes convergence work.
export function transformPair(a: TextOp, b: TextOp): [TextOp, TextOp] {
  if (a.type === "noop" || b.type === "noop") return [a, b];

  if (a.type === "insert" && b.type === "insert") {
    // Same position: a fixed rule (smaller client id goes first) so both sides
    // break the tie identically.
    const aFirst = a.index < b.index || (a.index === b.index && a.clientId <= b.clientId);
    return aFirst ? [a, { ...b, index: b.index + 1 }] : [{ ...a, index: a.index + 1 }, b];
  }

  if (a.type === "insert" && b.type === "delete") {
    // The insert lands at or before the deleted character: the delete shifts
    // right. Otherwise the delete removed something before the insert: the
    // insert shifts left.
    return a.index <= b.index
      ? [a, { ...b, index: b.index + 1 }]
      : [{ ...a, index: a.index - 1 }, b];
  }

  if (a.type === "delete" && b.type === "insert") {
    const [b2, a2] = transformPair(b, a);
    return [a2, b2];
  }

  // delete / delete
  const ad = a as Extract<TextOp, { type: "delete" }>;
  const bd = b as Extract<TextOp, { type: "delete" }>;
  if (ad.index < bd.index) return [ad, { ...bd, index: bd.index - 1 }];
  if (ad.index > bd.index) return [{ ...ad, index: ad.index - 1 }, bd];
  // Both deleted the same character: it is gone once, so both become no-ops.
  return [noop(ad.clientId), noop(bd.clientId)];
}

// Shift a cursor/selection offset through an op (used to keep a user's caret
// in place while others type).
export function transformCursor(cursor: number, op: TextOp): number {
  if (op.type === "insert") return op.index < cursor ? cursor + 1 : cursor;
  if (op.type === "delete") return op.index < cursor ? cursor - 1 : cursor;
  return cursor;
}

// Turn "old text became new text" into a short list of character operations.
// Finds the common prefix and suffix; what is left in the middle was replaced.
export function diffToOps(oldText: string, newText: string, clientId: string): TextOp[] {
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = oldText.length - prefix - suffix;
  const inserted = newText.slice(prefix, newText.length - suffix);
  const ops: TextOp[] = [];
  for (let i = 0; i < removed; i++) ops.push({ type: "delete", index: prefix, clientId });
  for (let i = 0; i < inserted.length; i++) {
    ops.push({ type: "insert", index: prefix + i, char: inserted[i], clientId });
  }
  return ops;
}

// ---- the client half of the protocol ---------------------------------------
//
// A client keeps at most ONE operation in flight to the server (`outstanding`)
// and queues everything else locally (`buffer`). That restriction is what lets
// plain pairwise transformation (TP1) be enough: the server only ever has to
// transform an incoming op against operations the client had not yet seen.
//
//   state "synchronized":      outstanding = null,  buffer = []
//   state "awaiting ack":      outstanding = op,    buffer = []
//   state "awaiting + buffer": outstanding = op,    buffer = [..]

export class TextClient {
  outstanding: TextOp | null = null;
  buffer: TextOp[] = [];

  constructor(
    public rev: number,
    private send: (op: TextOp, rev: number) => void,
  ) {}

  // The user made a local edit (already applied to their text).
  local(op: TextOp): void {
    if (!this.outstanding) {
      this.outstanding = op;
      this.send(op, this.rev);
    } else {
      this.buffer.push(op);
    }
  }

  // The server confirmed our outstanding op.
  ack(): void {
    this.rev += 1;
    this.outstanding = null;
    const next = this.buffer.shift();
    if (next) {
      this.outstanding = next;
      this.send(next, this.rev);
    }
  }

  // Another user's op arrived. Returns the op to apply to the local text, and
  // rewrites our own unconfirmed ops so they still make sense after it.
  remote(op: TextOp): TextOp {
    this.rev += 1;
    let incoming = op;
    if (this.outstanding) {
      const [mine, theirs] = transformPair(this.outstanding, incoming);
      this.outstanding = mine;
      incoming = theirs;
    }
    this.buffer = this.buffer.map((queued) => {
      const [mine, theirs] = transformPair(queued, incoming);
      incoming = theirs;
      return mine;
    });
    return incoming;
  }
}

// ---- the server half ---------------------------------------------------------

export interface ServerText {
  text: string;
  rev: number; // number of ops applied so far
  baseRev: number; // history[0] is op number baseRev
  history: TextOp[];
}

export function newServerText(text = "", rev = 0): ServerText {
  return { text, rev, baseRev: rev, history: [] };
}

// Rewrite a client's op (made at revision `clientRev`) so it applies to the
// current text. Returns null if the client is too far behind (history was
// trimmed) or the op is invalid.
export function serverTransform(doc: ServerText, op: TextOp, clientRev: number): TextOp | null {
  if (clientRev < doc.baseRev || clientRev > doc.rev) return null;
  let current = op;
  for (const applied of doc.history.slice(clientRev - doc.baseRev)) {
    current = transformPair(current, applied)[0];
  }
  return isValidTextOp(current, doc.text.length) ? current : null;
}

export function serverCommit(doc: ServerText, op: TextOp): void {
  doc.text = applyText(doc.text, op);
  doc.history.push(op);
  doc.rev += 1;
}
