import { getBoundingBox, type Shape, type SyncEngine } from "@liveboard/shared";
import { distToSegment, toLocal } from "./geometry";

// A read-only view of the shapes in the sync engine, plus hit testing.
// All changes go through the engine so they are synced; the board only reads.
export class Board {
  private sorted: Shape[] = [];
  private sortedVersion = -1;

  constructor(private engine: SyncEngine) {
    let h = 0;
    for (const ch of engine.clientId) h = (h * 31 + ch.charCodeAt(0)) % 99_991;
    this.zSalt = h / 100_000; // in [0, 1)
  }

  // A small fraction unique to this client (stable for the session). Two people
  // adding a shape at the same instant both ask for "highest layer + 1"; the
  // fraction keeps their answers different, so layers never tie.
  private readonly zSalt: number;

  // Above everything currently on the board, including shapes from other users.
  allocateZ(): number {
    let max = -1;
    for (const s of this.engine.shapes.values()) max = Math.max(max, s.zIndex);
    return Math.floor(max) + 1 + this.zSalt;
  }

  get(id: string): Shape | undefined {
    return this.engine.shapes.get(id);
  }

  // Back to front. The id breaks ties so every client sorts identically.
  // Re-sorted only when something changed, not on every frame.
  list(): Shape[] {
    if (this.sortedVersion !== this.engine.version) {
      this.sorted = [...this.engine.shapes.values()].sort(
        (a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1),
      );
      this.sortedVersion = this.engine.version;
    }
    return this.sorted;
  }

  // Topmost shape under the point. Lines and strokes are hit by distance to
  // the actual path; everything else by its (padded) bounding box.
  hitTest(wx: number, wy: number): Shape | undefined {
    const shapes = this.list();
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const p = toLocal(s, { x: wx, y: wy });
      const tol = Math.max(s.strokeWidth, 6);

      if (s.points && s.points.length > 0) {
        const pts = s.points.map(([px, py]) => ({ x: s.x + px, y: s.y + py }));
        if (pts.length === 1) {
          if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tol) return s;
          continue;
        }
        for (let j = 0; j < pts.length - 1; j++) {
          if (distToSegment(p, pts[j], pts[j + 1]) <= tol) return s;
        }
        continue;
      }

      const box = getBoundingBox(s);
      if (
        p.x >= box.x - tol &&
        p.x <= box.x + box.width + tol &&
        p.y >= box.y - tol &&
        p.y <= box.y + box.height + tol
      ) {
        return s;
      }
    }
    return undefined;
  }
}
