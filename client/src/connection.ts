import {
  SyncEngine,
  type ClientMessage,
  type EngineOptions,
  type PresenceUser,
  type ServerMessage,
} from "@liveboard/shared";

export type Status = "connecting" | "online" | "offline";

export interface JoinInfo {
  roomId: string;
  displayName: string;
  password?: string;
  token?: string;
}

const RETRY_PENDING_MS = 2500;
const CURSOR_INTERVAL_MS = 33;

// Owns the WebSocket and the SyncEngine it feeds. Reconnects automatically
// with backoff, resumes from the last operation it saw (so the server only
// sends what was missed), and re-sends anything the server never confirmed.
// While offline, edits keep working and queue up inside the engine.
export class Connection {
  readonly engine: SyncEngine;
  readonly clientId = `c-${crypto.randomUUID()}`;
  status: Status = "offline";
  users: PresenceUser[] = [];
  me?: PresenceUser;

  onStatus: (status: Status) => void = () => {};
  onPresence: (users: PresenceUser[]) => void = () => {};
  onCursor: (cursor: { clientId: string; x: number; y: number; laser?: boolean }) => void = () => {};
  onReaction: (reaction: { clientId: string; emoji: string }) => void = () => {};
  // The board is closed to us: needs a (different) password, or has a bad name.
  onRefused: (code: string, message: string) => void = () => {};

  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer?: number;
  private lastCursorAt = 0;

  constructor(
    private url: string,
    private join: JoinInfo,
    engineOptions: Omit<EngineOptions, "clientId" | "send">,
  ) {
    this.engine = new SyncEngine({
      ...engineOptions,
      clientId: this.clientId,
      send: (msg) => this.sendRaw(msg),
    });
    // An operation the server never confirms (lost with a crashed server, say)
    // is simply sent again; duplicates are harmless.
    window.setInterval(() => {
      if (this.status === "online" && this.engine.pendingCount > 0) this.engine.resendPending();
    }, RETRY_PENDING_MS);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  setPassword(password: string): void {
    this.join.password = password;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  sendCursor(x: number, y: number, laser = false): void {
    const now = performance.now();
    if (this.status !== "online" || now - this.lastCursorAt < CURSOR_INTERVAL_MS) return;
    this.lastCursorAt = now;
    this.sendRaw({ type: "cursor", x, y, laser });
  }

  sendReaction(emoji: string): void {
    if (this.status === "online") this.sendRaw({ type: "react", emoji });
  }

  private setStatus(status: Status): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  private sendRaw(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === "online") {
      this.ws.send(JSON.stringify(msg));
    }
    // Otherwise the engine still holds the op in its pending list and
    // resends it after the next successful join.
  }

  private open(): void {
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      const join: ClientMessage = {
        type: "join",
        roomId: this.join.roomId,
        clientId: this.clientId,
        displayName: this.join.displayName,
        lastSeq: this.engine.lastSeq,
        password: this.join.password,
        token: this.join.token,
      };
      ws.send(JSON.stringify(join));
    });

    ws.addEventListener("message", (event) => {
      if (ws !== this.ws) return;
      const msg = JSON.parse(event.data as string) as ServerMessage;
      switch (msg.type) {
        case "sync":
          this.me = msg.you;
          this.attempt = 0;
          this.setStatus("online"); // before handle(): the resend inside needs "online"
          this.engine.handle(msg);
          break;
        case "op":
          this.engine.handle(msg);
          break;
        case "presence":
          this.users = msg.users;
          this.onPresence(msg.users);
          break;
        case "reaction":
          this.onReaction(msg);
          break;
        case "cursor":
          this.onCursor(msg);
          break;
        case "error":
          this.onServerError(msg.code, msg.message);
          break;
      }
    });

    ws.addEventListener("close", () => {
      if (ws !== this.ws) return;
      this.setStatus("offline");
      if (this.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    });
    ws.addEventListener("error", () => {});
  }

  private onServerError(code: string, message: string): void {
    if (code === "rejected") {
      // Our view and the server's have drifted apart (should be rare). Throw
      // away the resume point so the next join sends the whole board.
      this.engine.lastSeq = 0;
      this.ws?.close();
      return;
    }
    if (code === "password-required" || code === "bad-password" || code === "bad-room") {
      this.stopped = true;
      this.ws?.close();
      this.onRefused(code, message);
      return;
    }
    console.warn(`server: ${code}: ${message}`);
  }
}
