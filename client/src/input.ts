import {
  createShape,
  getBoundingBox,
  type Point,
  type Shape,
  type ShapeProps,
  type ShapeType,
  type SyncEngine,
} from "@liveboard/shared";
import type { Board } from "./board";
import type { Connection } from "./connection";
import {
  cloneShapes,
  erasePath,
  normalizeRect,
  reorderZ,
  shapesInRect,
  unionBounds,
  type Rect,
  type ReorderMode,
} from "./edit";
import {
  boxCenter,
  groupResize,
  groupRotate,
  hitBoxHandle,
  hitHandle,
  resizeFromHandle,
  rotationFromPointer,
  type Pt,
  type ResizeHandle,
} from "./geometry";
import type { History, HistoryItem } from "./history";
import { applicable, applyLook, DEFAULT_LOOK, lookOf, type Look } from "./look";
import { GRID, MAX_ZOOM, MIN_ZOOM, screenToWorld, type CanvasRenderer } from "./renderer";
import type { TextEditing } from "./text";

export type Tool = "select" | "hand" | "pen" | "eraser" | "text" | "laser" | Exclude<ShapeType, "path" | "text">;

type Gesture =
  | { kind: "laser" }
  | { kind: "draw"; id: string; type: ShapeType; origin: Pt; points: Point[]; latest: ShapeProps; lastSent: number }
  | { kind: "move"; origs: Shape[]; start: Pt }
  | { kind: "resize"; handle: ResizeHandle; orig: Shape }
  | { kind: "rotate"; orig: Shape }
  | { kind: "groupResize"; handle: ResizeHandle; origs: Shape[]; box: Rect }
  | { kind: "groupRotate"; origs: Shape[]; centre: Pt; startAngle: number }
  | { kind: "erase"; items: HistoryItem[] }
  | { kind: "marquee"; start: Pt; base: Set<string> }
  | { kind: "pan"; lastX: number; lastY: number };

const SEND_INTERVAL_MS = 33; // while drawing, ~30 updates a second is plenty
const EDIT_KEYS: (keyof ShapeProps)[] = ["x", "y", "width", "height", "points", "rotation"];
const ERASER_RADIUS_PX = 10;
const CLIPBOARD_KEY = "lb.clipboard";
const TOOL_KEYS: Record<string, Tool> = {
  v: "select", h: "hand", p: "pen", r: "rect", o: "circle", l: "line", a: "arrow", t: "text", e: "eraser", k: "laser",
};

function pick(shape: Shape, keys: (keyof ShapeProps)[]): ShapeProps {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = structuredClone(shape[key]);
  return out as ShapeProps;
}

// Turns pointer and keyboard events into edits on the sync engine. It never
// changes shapes directly: everything goes through the engine so it is
// applied locally at once, sent to the server, and (for undo) recorded.
export class InputHandler {
  private toolName: Tool = "select";
  onViewChange: () => void = () => {};
  onToolChange: (tool: Tool) => void = () => {};

  // The look given to new shapes, and applied to the selection when changed.
  look: Look = { ...DEFAULT_LOOK };
  onSelect: (shapes: Shape[]) => void = () => {};
  // Grid and snap are switched from the keyboard (G, Shift+G); the app shows them.
  onGridKey: (which: "grid" | "snap") => void = () => {};
  snap = false;
  // The laser pointer needs the user's colour for its own trail.
  laserColor: () => string = () => "#e03131";

  private gesture: Gesture | null = null;
  private spaceDown = false;
  private pasteCount = 0;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; worldMid: Pt } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private board: Board,
    private renderer: CanvasRenderer,
    private engine: SyncEngine,
    private history: History,
    private conn: Connection,
    private text: TextEditing,
  ) {
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointercancel", (e) => this.onUp(e));
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spaceDown = false;
    });
  }

  get tool(): Tool {
    return this.toolName;
  }

  set tool(tool: Tool) {
    this.toolName = tool;
    if (tool !== "select") this.setSelection([]);
    this.onToolChange(tool);
  }

  // ---- selection ---------------------------------------------------------

  selectedShapes(): Shape[] {
    return [...this.renderer.selection].map((id) => this.board.get(id)).filter((s): s is Shape => !!s);
  }

  private setSelection(ids: Iterable<string>): void {
    this.renderer.selection = new Set(ids);
    const shapes = this.selectedShapes();
    // Selecting a shape makes its look the one new shapes will use, like a
    // dropper: pick the red dashed rectangle and the next one is red and dashed.
    if (shapes[0]) Object.assign(this.look, lookOf(shapes[0]));
    this.onSelect(shapes);
  }

  // Round a world position to the nearest grid dot when snapping is on.
  private snapped(p: Pt): Pt {
    return this.snap ? { x: Math.round(p.x / GRID) * GRID, y: Math.round(p.y / GRID) * GRID } : p;
  }

  selectAll(): void {
    this.setSelection(this.board.list().map((s) => s.id));
  }

  // ---- actions (also used by the toolbar) -----------------------------------

  undo(): void {
    this.history.undo();
  }

  redo(): void {
    this.history.redo();
  }

  // Change the default look, and restyle every selected shape (one undo step).
  setStyle(change: Partial<Look>): void {
    Object.assign(this.look, change);
    const items: HistoryItem[] = [];
    for (const s of this.selectedShapes()) {
      const props = applicable(change, s.type); // only what makes sense for this kind of shape
      const keys = Object.keys(props) as (keyof ShapeProps)[];
      if (keys.length === 0) continue;
      const before = pick(s, keys);
      this.engine.setProps(s.id, props);
      const item = this.history.edited(s.id, before, props);
      if (item) items.push(item);
    }
    this.history.record(items);
  }

  deleteSelection(): void {
    const items: HistoryItem[] = [];
    for (const s of this.selectedShapes()) {
      this.engine.removeShape(s.id);
      items.push({ kind: "deleted", id: s.id });
    }
    this.setSelection([]);
    this.history.record(items);
  }

  reorder(mode: ReorderMode): void {
    const changes = reorderZ(this.board.list(), this.renderer.selection, mode);
    const items: HistoryItem[] = [];
    for (const [id, zIndex] of changes) {
      const shape = this.board.get(id);
      if (!shape) continue;
      const before = { zIndex: shape.zIndex };
      this.engine.setProps(id, { zIndex });
      const item = this.history.edited(id, before, { zIndex });
      if (item) items.push(item);
    }
    this.history.record(items);
  }

  copy(): void {
    const shapes = this.selectedShapes();
    if (shapes.length === 0) return;
    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(shapes)); // also works across boards and tabs
    this.pasteCount = 0;
  }

  cut(): void {
    this.copy();
    this.deleteSelection();
  }

  paste(): void {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    if (!raw) return;
    this.pasteShapes(JSON.parse(raw) as Shape[], 20 * ++this.pasteCount);
  }

  duplicate(): void {
    this.pasteShapes(this.selectedShapes(), 20);
  }

  private pasteShapes(shapes: Shape[], offset: number): void {
    if (shapes.length === 0) return;
    const copies = cloneShapes(shapes, offset, offset, this.board.allocateZ() - 1, () => crypto.randomUUID());
    const items: HistoryItem[] = [];
    for (const { shape, text } of copies) {
      this.engine.addShape(shape);
      if (text) this.engine.editText(shape.id, text); // text content travels as OT operations
      items.push({ kind: "created", id: shape.id });
    }
    this.setSelection(copies.map((c) => c.shape.id));
    this.history.record(items);
  }

  private nudge(dx: number, dy: number): void {
    const items: HistoryItem[] = [];
    for (const s of this.selectedShapes()) {
      const before = { x: s.x, y: s.y };
      const after = { x: s.x + dx, y: s.y + dy };
      this.engine.setProps(s.id, after);
      const item = this.history.edited(s.id, before, after);
      if (item) items.push(item);
    }
    this.history.record(items);
  }

  // ---- pointer events ----------------------------------------------------

  private world(e: PointerEvent | MouseEvent): Pt {
    return screenToWorld(e.offsetX, e.offsetY, this.renderer.view);
  }

  private onDown(e: PointerEvent): void {
    this.text.close(); // a click on the canvas always finishes any open text edit

    if (e.pointerType === "touch") {
      const rect = this.canvas.getBoundingClientRect();
      this.touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (this.touches.size === 2) return this.startPinch();
      if (this.touches.size > 2) return;
    }

    if (e.button === 1 || this.spaceDown || this.tool === "hand") {
      this.gesture = { kind: "pan", lastX: e.clientX, lastY: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const w = this.world(e);
    this.canvas.setPointerCapture(e.pointerId);

    switch (this.tool) {
      case "select":
        return this.startSelect(w, e.shiftKey);
      case "eraser":
        this.gesture = { kind: "erase", items: [] };
        return this.eraseAt(w);
      case "laser":
        this.gesture = { kind: "laser" };
        return this.pointLaser(w);
      case "text": {
        const hit = this.board.hitTest(w.x, w.y);
        if (hit?.type === "text") return this.beginTextEdit(hit.id, false);
        const shape = createShape("text", w.x, w.y, this.board.allocateZ());
        applyLook(shape, this.look); // colour, font and size for the new text
        this.engine.addShape(shape);
        return this.beginTextEdit(shape.id, true);
      }
      default:
        return this.startDraw(this.snapped(w));
    }
  }

  private startSelect(w: Pt, additive: boolean): void {
    const only = this.renderer.selection.size === 1 ? this.selectedShapes()[0] : undefined;
    if (only) {
      const handle = hitHandle(only, w, this.renderer.view.zoom);
      if (handle === "rotate") {
        this.gesture = { kind: "rotate", orig: structuredClone(only) };
        return;
      }
      if (handle) {
        this.gesture = { kind: "resize", handle, orig: structuredClone(only) };
        return;
      }
    }

    const many = this.selectedShapes();
    if (many.length > 1) {
      const box = unionBounds(many);
      const handle = hitBoxHandle(box, w, this.renderer.view.zoom);
      const origs = structuredClone(many);
      if (handle === "rotate") {
        const centre = boxCenter(box);
        this.gesture = { kind: "groupRotate", origs, centre, startAngle: Math.atan2(w.y - centre.y, w.x - centre.x) };
        return;
      }
      if (handle) {
        this.gesture = { kind: "groupResize", handle, origs, box };
        return;
      }
    }

    const hit = this.board.hitTest(w.x, w.y);
    if (!hit) {
      // Empty space: start a rubber band (keeping the old selection if Shift is held).
      const base = additive ? new Set(this.renderer.selection) : new Set<string>();
      this.setSelection(base);
      this.gesture = { kind: "marquee", start: w, base };
      return;
    }
    if (additive) {
      const next = new Set(this.renderer.selection);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      this.setSelection(next);
      if (!next.has(hit.id)) return; // shift-click removed it: nothing to drag
    } else if (!this.renderer.selection.has(hit.id)) {
      this.setSelection([hit.id]);
    }
    this.gesture = { kind: "move", origs: structuredClone(this.selectedShapes()), start: w };
  }

  private startDraw(w: Pt): void {
    const type: ShapeType = this.tool === "pen" ? "path" : (this.tool as ShapeType);
    const shape = createShape(type, w.x, w.y, this.board.allocateZ());
    applyLook(shape, this.look); // only the parts of the look that suit this kind of shape
    this.engine.addShape(shape);
    this.gesture = { kind: "draw", id: shape.id, type, origin: w, points: [[0, 0]], latest: {}, lastSent: 0 };
  }

  // A laser pointer leaves a short glowing trail, for you and for everyone else.
  private pointLaser(w: Pt): void {
    this.renderer.addLaserPoint(this.conn.clientId, w.x, w.y, this.laserColor());
    this.conn.sendCursor(w.x, w.y, true);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      const rect = this.canvas.getBoundingClientRect();
      this.touches.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      if (this.pinch) return this.updatePinch();
    }

    const w = this.world(e);
    const g = this.gesture;
    if (g?.kind === "laser") this.pointLaser(w);
    else this.conn.sendCursor(w.x, w.y);
    if (!g) return;
    if (g.kind === "pan") {
      this.renderer.view.panX += e.clientX - g.lastX;
      this.renderer.view.panY += e.clientY - g.lastY;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      this.onViewChange();
      return;
    }

    switch (g.kind) {
      case "erase":
        return this.eraseAt(w);
      case "move": {
        let dx = w.x - g.start.x;
        let dy = w.y - g.start.y;
        if (this.snap && g.origs[0]) {
          // Land the first shape on a grid dot; the rest keep their distance from it.
          const t = this.snapped({ x: g.origs[0].x + dx, y: g.origs[0].y + dy });
          dx = t.x - g.origs[0].x;
          dy = t.y - g.origs[0].y;
        }
        for (const o of g.origs) this.engine.setProps(o.id, { x: o.x + dx, y: o.y + dy });
        return;
      }
      case "resize":
        this.engine.setProps(g.orig.id, resizeFromHandle(g.orig, g.handle, w));
        return;
      case "rotate":
        this.engine.setProps(g.orig.id, { rotation: rotationFromPointer(g.orig, w) });
        return;
      case "groupResize":
        for (const [id, props] of groupResize(g.origs, g.box, g.handle, w)) this.engine.setProps(id, props);
        return;
      case "groupRotate": {
        const delta = Math.atan2(w.y - g.centre.y, w.x - g.centre.x) - g.startAngle;
        for (const [id, props] of groupRotate(g.origs, g.centre, delta)) this.engine.setProps(id, props);
        return;
      }
      case "marquee": {
        const rect = normalizeRect(g.start.x, g.start.y, w.x, w.y);
        this.renderer.marquee = rect;
        const inside = shapesInRect(this.board.list(), rect).map((s) => s.id);
        this.renderer.selection = new Set([...g.base, ...inside]);
        return;
      }
      case "draw":
        return this.drawTo(g, g.type === "path" ? w : this.snapped(w), false);
    }
  }

  private drawTo(g: Extract<Gesture, { kind: "draw" }>, w: Pt, force: boolean): void {
    switch (g.type) {
      case "rect":
      case "circle":
        // Normalise so width/height stay positive when dragging up or left.
        g.latest = {
          x: Math.min(g.origin.x, w.x),
          y: Math.min(g.origin.y, w.y),
          width: Math.abs(w.x - g.origin.x),
          height: Math.abs(w.y - g.origin.y),
        };
        break;
      case "line":
      case "arrow":
        g.latest = { points: [[0, 0], [w.x - g.origin.x, w.y - g.origin.y]] };
        break;
      default:
        g.points.push([w.x - g.origin.x, w.y - g.origin.y]);
        g.latest = { points: g.points };
    }
    const now = performance.now();
    if (!force && now - g.lastSent < SEND_INTERVAL_MS) return;
    g.lastSent = now;
    this.engine.setProps(g.id, g.latest);
  }

  // Whole shapes are removed; a freehand stroke is cut where the eraser touches
  // it, leaving the rest as separate strokes.
  private eraseAt(w: Pt): void {
    const g = this.gesture;
    if (!g || g.kind !== "erase") return;
    const hit = this.board.hitTest(w.x, w.y);
    if (!hit) return;
    this.renderer.selection.delete(hit.id);

    if (hit.type === "path") {
      const cut = erasePath(hit, w.x, w.y, ERASER_RADIUS_PX / this.renderer.view.zoom);
      if (!cut.removedAny) return;
      this.engine.removeShape(hit.id);
      g.items.push({ kind: "deleted", id: hit.id });
      for (const points of cut.pieces) {
        const piece: Shape = { ...structuredClone(hit), id: crypto.randomUUID(), points };
        this.engine.addShape(piece);
        g.items.push({ kind: "created", id: piece.id });
      }
      return;
    }
    this.engine.removeShape(hit.id);
    g.items.push({ kind: "deleted", id: hit.id });
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.pinch && this.touches.size < 2) this.pinch = null;
    }
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;

    switch (g.kind) {
      case "move":
      case "groupResize":
      case "groupRotate": {
        const items: HistoryItem[] = [];
        for (const orig of g.origs) {
          const now = this.board.get(orig.id);
          const item = now && this.history.edited(orig.id, pick(orig, EDIT_KEYS), pick(now, EDIT_KEYS));
          if (item) items.push(item);
        }
        this.history.record(items);
        return;
      }
      case "resize":
      case "rotate": {
        const now = this.board.get(g.orig.id);
        if (!now) return;
        const item = this.history.edited(g.orig.id, pick(g.orig, EDIT_KEYS), pick(now, EDIT_KEYS));
        if (item) this.history.record([item]);
        return;
      }
      case "erase":
        this.history.record(g.items);
        return;
      case "marquee":
        this.renderer.marquee = null;
        this.onSelect(this.selectedShapes());
        return;
      case "draw": {
        if (Object.keys(g.latest).length) this.engine.setProps(g.id, g.latest); // final position
        const shape = this.board.get(g.id);
        const box = shape && getBoundingBox(shape);
        if (!box || (box.width < 2 && box.height < 2)) this.engine.removeShape(g.id); // an accidental click
        else this.history.record([{ kind: "created", id: g.id }]);
      }
    }
  }

  // ---- two-finger pinch: zoom and pan together --------------------------------

  private startPinch(): void {
    // A second finger turns the touch into a gesture on the view, so drop
    // whatever the first finger had started.
    const g = this.gesture;
    if (g?.kind === "draw") {
      const shape = this.board.get(g.id);
      const box = shape && getBoundingBox(shape);
      if (!box || (box.width < 6 && box.height < 6)) this.engine.removeShape(g.id);
    }
    this.gesture = null;
    const [a, b] = [...this.touches.values()];
    const view = this.renderer.view;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.zoom, worldMid: screenToWorld(mid.x, mid.y, view) };
  }

  private updatePinch(): void {
    const p = this.pinch;
    const pts = [...this.touches.values()];
    if (!p || pts.length < 2) return;
    const [a, b] = pts;
    const view = this.renderer.view;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = p.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / p.dist);
    view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    // The point between the fingers stays between the fingers.
    view.panX = mid.x - p.worldMid.x * view.zoom;
    view.panY = mid.y - p.worldMid.y * view.zoom;
    this.onViewChange();
  }

  // ---- text ---------------------------------------------------------------

  private onDoubleClick(e: MouseEvent): void {
    if (this.tool !== "select") return;
    const w = this.world(e);
    const hit = this.board.hitTest(w.x, w.y);
    if (hit?.type === "text") this.beginTextEdit(hit.id, false);
  }

  private beginTextEdit(id: string, created: boolean): void {
    this.text.edit(id, created, (finalText, wasCreated) => {
      const empty = finalText.trim() === "";
      if (wasCreated) {
        if (empty) this.engine.removeShape(id); // never typed anything: nothing to keep
        else this.history.record([{ kind: "created", id }]);
      } else if (empty) {
        this.engine.removeShape(id);
        this.history.record([{ kind: "deleted", id }]);
      }
    });
  }

  // ---- zoom and keyboard -------------------------------------------------

  // Zoom around the cursor: the world point under the mouse stays put.
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const view = this.renderer.view;
    const before = screenToWorld(e.offsetX, e.offsetY, view);
    const zoom = view.zoom * Math.exp(-e.deltaY * 0.0015);
    view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    view.panX = e.offsetX - before.x * view.zoom;
    view.panY = e.offsetY - before.y * view.zoom;
    this.onViewChange();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT") return;

    if (e.code === "Space") {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod) {
      const handled = this.onShortcut(key, e.shiftKey);
      if (handled) e.preventDefault();
      return;
    }
    if (TOOL_KEYS[key] && !e.altKey) {
      this.tool = TOOL_KEYS[key];
    } else if (key === "g") {
      this.onGridKey(e.shiftKey ? "snap" : "grid");
    } else if (key === "delete" || key === "backspace") {
      this.deleteSelection();
    } else if (key === "escape") {
      this.setSelection([]);
    } else if (key === "[" || key === "]") {
      this.reorder(key === "]" ? "forward" : "backward");
    } else if (key.startsWith("arrow")) {
      const step = e.shiftKey ? 10 : 1;
      const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
      const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
      this.nudge(dx, dy);
      e.preventDefault();
    }
  }

  private onShortcut(key: string, shift: boolean): boolean {
    switch (key) {
      case "z":
        if (shift) this.redo();
        else this.undo();
        return true;
      case "y":
        this.redo();
        return true;
      case "a":
        this.selectAll();
        return true;
      case "c":
        this.copy();
        return true;
      case "x":
        this.cut();
        return true;
      case "v":
        this.paste();
        return true;
      case "d":
        this.duplicate();
        return true;
      case "]":
        this.reorder("front");
        return true;
      case "[":
        this.reorder("back");
        return true;
      default:
        return false;
    }
  }
}
