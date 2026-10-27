import { RoomCore, SyncEngine, type ClientOp, type SequencedOp } from "@liveboard/shared";

// A server and any number of headless clients, connected in memory. Nothing is
// delivered until flush() is called, so tests control exactly who has seen what.
export class Pair {
  core = new RoomCore();
  engines: SyncEngine[] = [];
  private seq = 0;
  private upstream: ClientOp[] = [];
  private downstream: SequencedOp[][] = [];
  private tick = 1000;

  add(name: string): SyncEngine {
    const i = this.engines.length;
    this.downstream.push([]);
    const engine = new SyncEngine({
      clientId: name,
      now: () => this.tick++, // time only moves forward, one tick per call
      send: (m) => {
        if (m.type === "op") this.upstream.push(structuredClone(m.op));
      },
    });
    this.engines.push(engine);
    void i;
    return engine;
  }

  // Deliver everything in flight, both directions, until the system is quiet.
  flush(): void {
    for (let guard = 0; guard < 10_000; guard++) {
      const op = this.upstream.shift();
      if (op) {
        const prepared = this.core.prepare(op);
        if (!prepared.ok) continue;
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
