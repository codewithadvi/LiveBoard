import { compareHLC, type HLC, type ShapeProps, type SyncEngine } from "@liveboard/shared";

// One thing a user did to one shape.
export type HistoryItem =
  | { kind: "created"; id: string }
  | { kind: "deleted"; id: string }
  | {
      kind: "edited";
      id: string;
      before: ShapeProps;
      after: ShapeProps;
      // When each property was last written by this user's edit (or undo/redo
      // of it). If the register has a different stamp, someone else wrote it
      // since, and we must not overwrite their change.
      stamps: Record<string, HLC | undefined>;
    };

// One undoable user action (a drag, an erase stroke, ...): one or more items.
export type HistoryEntry = HistoryItem[];

// Per-user undo/redo. Only this user's own actions are ever recorded, so undo
// never reverts anyone else's work. Undo does not rewind the shared history:
// it sends new operations (the inverse), which merge like any other edit.
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private engine: SyncEngine) {}

  record(entry: HistoryEntry): void {
    if (entry.length === 0) return;
    this.undoStack.push(entry);
    this.redoStack = [];
  }

  // Build the "edited" item for a finished drag: only properties whose value
  // actually changed are kept.
  edited(id: string, before: ShapeProps, after: ShapeProps): HistoryItem | undefined {
    const b: Record<string, unknown> = {};
    const a: Record<string, unknown> = {};
    const stamps: Record<string, HLC | undefined> = {};
    for (const key of Object.keys(after)) {
      const k = key as keyof ShapeProps;
      if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
      b[key] = before[k];
      a[key] = after[k];
      stamps[key] = this.engine.registerTs(id, key);
    }
    if (Object.keys(a).length === 0) return undefined;
    return { kind: "edited", id, before: b as ShapeProps, after: a as ShapeProps, stamps };
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    for (const item of [...entry].reverse()) this.reverse(item);
    this.redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    for (const item of entry) this.replay(item);
    this.undoStack.push(entry);
    return true;
  }

  private reverse(item: HistoryItem): void {
    if (item.kind === "created") this.engine.removeShape(item.id);
    else if (item.kind === "deleted") this.engine.restoreShape(item.id);
    else this.writeIfUntouched(item, item.before);
  }

  private replay(item: HistoryItem): void {
    if (item.kind === "created") this.engine.restoreShape(item.id);
    else if (item.kind === "deleted") this.engine.removeShape(item.id);
    else this.writeIfUntouched(item, item.after);
  }

  // Write `values`, but only the properties nobody else has changed since our
  // last write. Then remember the new stamps so the opposite action can check.
  private writeIfUntouched(item: Extract<HistoryItem, { kind: "edited" }>, values: ShapeProps): void {
    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(values)) {
      const mine = item.stamps[key];
      const current = this.engine.registerTs(item.id, key);
      if (mine && current && compareHLC(mine, current) === 0) safe[key] = (values as Record<string, unknown>)[key];
    }
    if (Object.keys(safe).length === 0) return;
    this.engine.setProps(item.id, safe as ShapeProps);
    for (const key of Object.keys(safe)) item.stamps[key] = this.engine.registerTs(item.id, key);
  }
}
