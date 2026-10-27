// Hybrid Logical Clock: (physical ms, logical counter, client id).
// Compared lexicographically, so any two timestamps from different clients are
// totally ordered, and if event A caused event B then hlc(A) < hlc(B).
export interface HLC {
  t: number;
  c: number;
  id: string;
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.c !== b.c) return a.c - b.c;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function hlcKey(h: HLC): string {
  return `${h.t}.${h.c}.${h.id}`;
}

export class HLCClock {
  private t = 0;
  private c = 0;

  constructor(
    private id: string,
    private now: () => number = Date.now,
  ) {}

  // Stamp a local event (or a message about to be sent).
  tick(): HLC {
    const pt = this.now();
    if (pt > this.t) {
      this.t = pt;
      this.c = 0;
    } else {
      this.c += 1;
    }
    return { t: this.t, c: this.c, id: this.id };
  }

  // Merge in a timestamp seen on a remote event, so our next tick is later.
  receive(remote: HLC): void {
    const pt = this.now();
    const t = Math.max(this.t, remote.t, pt);
    let c: number;
    if (t === this.t && t === remote.t) c = Math.max(this.c, remote.c) + 1;
    else if (t === this.t) c = this.c + 1;
    else if (t === remote.t) c = remote.c + 1;
    else c = 0;
    this.t = t;
    this.c = c;
  }
}
