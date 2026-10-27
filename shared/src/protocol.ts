import type { CrdtOp, DocState } from "./crdt";
import type { TextOp } from "./ot";

// What a client asks the server to do.
export type ClientBody =
  | { kind: "crdt"; op: CrdtOp }
  // `rev` is how many text ops for this shape the client had already folded in
  // when it made `op`. The server transforms against everything after that.
  | { kind: "text"; id: string; rev: number; op: TextOp };

export interface ClientOp {
  clientId: string;
  clientSeq: number; // 1, 2, 3 ... per client; lets the server drop duplicates
  body: ClientBody;
}

// The same operation after the server has put it in the one global order.
// For text, `body.op` is the transformed op and `body.rev` is its position in
// that shape's history.
export interface SequencedOp extends ClientOp {
  serverSeq: number;
}

export interface Snapshot {
  atSeq: number;
  doc: DocState;
}

export interface PresenceUser {
  clientId: string;
  displayName: string;
  color: string;
}

export type ClientMessage =
  | {
      type: "join";
      roomId: string;
      clientId: string;
      displayName: string;
      lastSeq: number;
      token?: string;
      password?: string;
    }
  | { type: "op"; op: ClientOp }
  // `laser` means the pointer is a laser pointer: others draw its fading trail.
  | { type: "cursor"; x: number; y: number; laser?: boolean }
  | { type: "react"; emoji: string };

// The only reactions the server will pass on (nothing user-supplied is relayed).
export const REACTIONS = ["👍", "❤️", "🎉", "😂", "🤔", "👀"] as const;

export type ServerMessage =
  | { type: "sync"; snapshot?: Snapshot; ops: SequencedOp[]; seq: number; you: PresenceUser }
  | { type: "op"; sop: SequencedOp }
  | { type: "presence"; users: PresenceUser[] }
  | { type: "cursor"; clientId: string; x: number; y: number; laser?: boolean }
  | { type: "reaction"; clientId: string; emoji: string }
  | { type: "error"; code: string; message: string };
