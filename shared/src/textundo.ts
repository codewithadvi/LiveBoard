import { applyText, isValidTextOp, transformPair, type TextOp } from "./ot";

// Per-user undo for one text box.
//
// Undoing "I typed abc" means deleting abc, but if someone has since typed
// before it, "delete at index 0" would now delete the wrong letters. So every
// stored undo is kept up to date with everything other people do: each time a
// remote edit lands, the stored operations are transformed against it, exactly
// like pending operations are. Undo itself is then just another ordinary edit.

interface Entry {
  ops: TextOp[]; // apply in this order to undo (or redo) the step
  at: number; // when the step was recorded, for merging fast typing
}

const MERGE_WINDOW_MS = 700;

// The operations that reverse `ops`, in the order they must be applied,
// worked out against the text the ops are about to be applied to.
export function inverseOps(text: string, ops: TextOp[], clientId: string): TextOp[] {
  const inverse: TextOp[] = [];
  let current = text;
  for (const op of ops) {
    if (op.type === "insert") inverse.push({ type: "delete", index: op.index, clientId });
    else if (op.type === "delete") inverse.push({ type: "insert", index: op.index, char: current[op.index] ?? "", clientId });
    current = applyText(current, op);
  }
  return inverse.reverse();
}

// Move `incoming` (an edit by someone else) across a chain of stored steps,
// rewriting each stored step so it still means the same thing afterwards.
function transformChain(stack: Entry[], incoming: TextOp): void {
  let carried = incoming;
  // The top step is defined on the current text; each one below is defined
  // after the one above it has been applied, so walk from the top down.
  for (let i = stack.length - 1; i >= 0; i--) {
    stack[i].ops = stack[i].ops.map((op) => {
      const [mine, theirs] = transformPair(op, carried);
      carried = theirs;
      return mine;
    });
  }
}

export class TextUndo {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];

  constructor(private clientId: string) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // Remember a local edit that turned `before` into the result of applying `ops`.
  record(before: string, ops: TextOp[], now: number): void {
    if (ops.length === 0) return;
    const inverse = inverseOps(before, ops, this.clientId);
    const last = this.undoStack[this.undoStack.length - 1];
    // Fast typing (or fast deleting) becomes one undo step, not one per letter.
    const sameKind = last && inverse.every((o) => o.type === last.ops[0]?.type && o.type !== "noop");
    if (last && sameKind && now - last.at < MERGE_WINDOW_MS) {
      last.ops = [...inverse, ...last.ops];
      last.at = now;
    } else {
      this.undoStack.push({ ops: inverse, at: now });
    }
    this.redoStack = [];
  }

  // Someone else's edit, already folded into the current text.
  remote(op: TextOp): void {
    transformChain(this.undoStack, op);
    transformChain(this.redoStack, op);
  }

  // Operations to apply to `text` to undo the latest step, or null if none.
  undo(text: string, now: number): TextOp[] | null {
    return this.step(this.undoStack, this.redoStack, text, now);
  }

  redo(text: string, now: number): TextOp[] | null {
    return this.step(this.redoStack, this.undoStack, text, now);
  }

  private step(from: Entry[], to: Entry[], text: string, now: number): TextOp[] | null {
    const entry = from.pop();
    if (!entry) return null;
    // Drop anything that no longer fits the text (its target was deleted by someone else).
    const ops: TextOp[] = [];
    let current = text;
    for (const op of entry.ops) {
      if (!isValidTextOp(op, current.length) || op.type === "noop") continue;
      ops.push(op);
      current = applyText(current, op);
    }
    to.push({ ops: inverseOps(text, ops, this.clientId), at: now });
    return ops;
  }
}
