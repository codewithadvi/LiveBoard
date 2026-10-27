import { SyncEngine } from "../src/engine.ts";
import type { ClientOp, SequencedOp } from "../src/protocol.ts";
import { RoomCore } from "../src/roomcore.ts";

// A server and any number of headless clients connected in memory. Nothing is
// delivered until flush() is called, so a test controls exactly who has seen what.
export class Pair {
  core = new RoomCore();
  engines: SyncEngine[] = [];
  clock = 1_000;
  private seq = 0;
  private upstream: ClientOp[] = [];
  private downstream: SequencedOp[][] = [];

  add(name: string): SyncEngine {
    this.downstream.push([]);
    const engine = new SyncEngine({
      clientId: name,
      now: () => this.clock,
      send: (m) => {
        if (m.type === "op") this.upstream.push(structuredClone(m.op));
      },
    });
    this.engines.push(engine);
    return engine;
  }

  flush(): void {
    for (let guard = 0; guard < 100_000; guard++) {
      const op = this.upstream.shift();
      if (op) {
        const prepared = this.core.prepare(op);
        if (!prepared.ok) throw new Error(`server rejected ${JSON.stringify(op)}: ${prepared.reason}`);
        const sop: SequencedOp = { ...op, body: prepared.body, serverSeq: ++this.seq };
        this.core.commit(sop);
        for (const q of this.downstream) q.push(structuredClone(sop));
        continue;
      }
      const i = this.downstream.findIndex((q) => q.length > 0);
      if (i < 0) return;
      this.engines[i].handle({ type: "op", sop: this.downstream[i].shift()! });
    }
    throw new Error("flush did not settle");
  }
}
