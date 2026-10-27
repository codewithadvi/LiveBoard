import { transformCursor, type Shape, type SyncEngine, type TextOp } from "@liveboard/shared";
import { fontCss, lineHeightOf } from "./drawing";
import type { View } from "./renderer";

let measureCtx: CanvasRenderingContext2D | undefined;

// Size of a text box: the widest line by the number of lines, in the shape's own font.
export function measureText(
  text: string,
  shape: Pick<Shape, "fontFamily" | "fontSize">,
): { width: number; height: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = fontCss(shape);
  const lines = text.split("\n");
  return {
    width: Math.max(8, ...lines.map((l) => measureCtx!.measureText(l).width)),
    height: Math.max(1, lines.length) * lineHeightOf(shape),
  };
}

interface Open {
  id: string;
  area: HTMLTextAreaElement;
  created: boolean;
  finish: () => void;
  fit: () => void;
}

// The floating <textarea> shown while a text box is being edited. Every
// keystroke goes straight into the sync engine (as OT operations), and edits
// from other people are folded into the textarea while keeping your caret
// where it was.
export class TextEditing {
  private open?: Open;

  constructor(
    private canvas: HTMLCanvasElement,
    private view: () => View,
    private engine: () => SyncEngine,
  ) {}

  get editingId(): string | undefined {
    return this.open?.id;
  }

  // `created` is true for a brand-new box, so closing it empty discards it.
  edit(id: string, created: boolean, onClosed: (text: string, created: boolean) => void): void {
    this.close();
    const engine = this.engine();
    const shape = engine.shapes.get(id);
    if (!shape) return;
    const view = this.view();
    const rect = this.canvas.getBoundingClientRect();

    const area = document.createElement("textarea");
    area.value = engine.textOf(id);
    area.spellcheck = false;
    Object.assign(area.style, {
      position: "fixed",
      left: `${rect.left + shape.x * view.zoom + view.panX}px`,
      top: `${rect.top + shape.y * view.zoom + view.panY}px`,
      minWidth: `${80 * view.zoom}px`,
      font: fontCss({ fontFamily: shape.fontFamily, fontSize: shape.fontSize * view.zoom }),
      lineHeight: `${lineHeightOf(shape) * view.zoom}px`,
      padding: "0",
      margin: "0",
      border: "1px dashed #4f7cff",
      outline: "none",
      background: "#fff",
      color: shape.stroke,
      resize: "none",
      overflow: "hidden",
      zIndex: "20",
    });
    // The box never wraps: it grows to fit what is typed, exactly as the text
    // will be drawn on the canvas.
    area.wrap = "off";
    const fit = () => {
      area.style.width = `${Math.max(80 * view.zoom, measureText(area.value, shape).width * view.zoom + 24)}px`;
      area.style.height = "auto";
      area.style.height = `${area.scrollHeight}px`;
    };

    area.addEventListener("input", () => {
      engine.editText(id, area.value);
      fit();
    });
    // Closing runs through finish() whether it was triggered by losing focus,
    // Escape, or the next click on the canvas, so it never depends on the
    // browser delivering a blur event.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const text = area.value;
      area.remove();
      if (this.open?.area === area) this.open = undefined;
      onClosed(text, created);
    };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        // The browser's own undo would fight with edits arriving from other
        // people, so undo goes through the sync engine: it reverses only what
        // YOU typed, wherever it has since moved to.
        e.preventDefault();
        const ops = key === "y" || e.shiftKey ? engine.redoText(id) : engine.undoText(id);
        if (ops) {
          area.value = engine.textOf(id);
          const last = ops[ops.length - 1];
          const caret = last && last.type !== "noop" ? last.index + (last.type === "insert" ? 1 : 0) : area.value.length;
          area.setSelectionRange(caret, caret);
          fit();
        }
      }
      e.stopPropagation(); // typing must not trigger tool shortcuts
    });
    area.addEventListener("blur", finish);

    document.body.appendChild(area);
    this.open = { id, area, created, finish, fit };
    fit();
    // Take focus on the next tick, not now. A click on the canvas moves focus
    // to the page AFTER our handler returns; focusing immediately would be
    // undone at once, closing the editor before anything could be typed.
    setTimeout(() => {
      if (done) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }, 0);
  }

  close(): void {
    this.open?.finish();
  }

  // Another user's edit to the box we have open.
  applyRemote(id: string, op: TextOp): void {
    const open = this.open;
    if (!open || open.id !== id) return;
    const { area } = open;
    const start = transformCursor(area.selectionStart, op);
    const end = transformCursor(area.selectionEnd, op);
    area.value = this.engine().textOf(id);
    area.setSelectionRange(start, end);
    open.fit();
  }
}
