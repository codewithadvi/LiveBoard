import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/700.css";
import "./style.css";

import { REACTIONS, type PresenceUser, type ShapeType } from "@liveboard/shared";
import { ensureName, getName, getToken, myBoards, setName, signInFlow, signOut } from "./account";
import { Board } from "./board";
import { Connection } from "./connection";
import { showDialog, showInfo } from "./dialog";
import { copyPng, exportPng, exportSvg } from "./exportPng";
import { History } from "./history";
import { icon, type IconName } from "./icons";
import { InputHandler, type Tool } from "./input";
import { startLandingPad } from "./landing";
import { keysFor, summarize, type LookKey } from "./look";
import { StylePanel, type PanelAction, type PanelModel } from "./panel";
import { CanvasRenderer } from "./renderer";
import { measureText, TextEditing } from "./text";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setIcon = (id: string, name: IconName, size = 22) => ($(id).innerHTML = icon(name, size));

// ---- small helpers ------------------------------------------------------------------

// Where the realtime server is. In development the page is served by Vite on
// its own port while the server runs on 8080; in production they share a port.
function socketUrl(): string {
  const override = new URLSearchParams(location.search).get("server");
  if (override) return override;
  if (import.meta.env.DEV) return `ws://${location.hostname}:8080`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

type Theme = "light" | "dark";
const theme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
function setTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("lb.theme", t);
}

let toastTimer: number | undefined;
function toast(message: string): void {
  document.getElementById("toast")?.remove();
  const el = document.createElement("div");
  el.id = "toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), 2000);
}

// Pick white or ink for text on a colour, so a light accent stays readable.
function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#1b2236" : "#ffffff";
}

function setAccent(color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--on-accent", readableOn(color));
}

const boardMatch = location.pathname.match(/^\/board\/([A-Za-z0-9_-]{1,64})\/?$/);
if (boardMatch) void startBoard(boardMatch[1]);
else void showLanding();

// ---- landing page ---------------------------------------------------------------------

async function showLanding(): Promise<void> {
  $("landing").hidden = false;
  startLandingPad($<HTMLCanvasElement>("pad"));

  const themeButton = $("theme-landing");
  const paintThemeIcon = () => (themeButton.innerHTML = icon(theme() === "dark" ? "sun" : "moon", 20));
  paintThemeIcon();
  themeButton.addEventListener("click", () => {
    setTheme(theme() === "dark" ? "light" : "dark");
    paintThemeIcon();
  });

  const refresh = async () => {
    const signedIn = !!getToken();
    $("landing-account").textContent = signedIn ? "Sign out" : "Sign in to see your boards";
    const list = $("landing-boards");
    list.replaceChildren();
    if (!signedIn) return;
    for (const b of await myBoards()) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `/board/${b.id}`;
      a.textContent = b.id;
      li.append(a, ` (${new Date(b.createdAt).toLocaleDateString()})`);
      list.appendChild(li);
    }
  };

  const open = (id: string, password: string) => {
    if (password) sessionStorage.setItem(`lb.pw.${id}`, password);
    location.href = `/board/${id}`;
  };
  $("landing-create").addEventListener("click", () => {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    open(id, $<HTMLInputElement>("landing-password").value.trim());
  });
  $("landing-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const field = $<HTMLInputElement>("landing-join");
    const id = field.value.trim().replace(/^.*\/board\//, "").replace(/[/?#].*$/, "");
    field.setCustomValidity("");
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) open(id, "");
    else {
      field.setCustomValidity("A board link, or a name made of letters, numbers, - and _");
      field.reportValidity();
    }
  });
  $("landing-account").addEventListener("click", async () => {
    if (getToken()) signOut();
    else await signInFlow();
    await refresh();
  });
  await refresh();
}

// ---- the board ---------------------------------------------------------------------------

interface ToolSpec {
  tool: Tool;
  icon: IconName;
  label: string;
  key: string;
}

const TOOLS: (ToolSpec | "sep")[] = [
  { tool: "select", icon: "select", label: "Select", key: "V" },
  { tool: "hand", icon: "hand", label: "Pan", key: "H" },
  "sep",
  { tool: "pen", icon: "pen", label: "Pen", key: "P" },
  { tool: "rect", icon: "rect", label: "Rectangle", key: "R" },
  { tool: "circle", icon: "circle", label: "Circle", key: "O" },
  { tool: "arrow", icon: "arrow", label: "Arrow", key: "A" },
  { tool: "line", icon: "line", label: "Line", key: "L" },
  { tool: "text", icon: "text", label: "Text", key: "T" },
  "sep",
  { tool: "eraser", icon: "eraser", label: "Eraser", key: "E" },
  { tool: "laser", icon: "laser", label: "Laser pointer", key: "K" },
];

// Tools that draw something new, and which kind of shape they make.
const DRAWS: Partial<Record<Tool, { type: ShapeType; noun: string }>> = {
  pen: { type: "path", noun: "pen strokes" },
  rect: { type: "rect", noun: "rectangles" },
  circle: { type: "circle", noun: "circles" },
  arrow: { type: "arrow", noun: "arrows" },
  line: { type: "line", noun: "lines" },
  text: { type: "text", noun: "text" },
};

const TYPE_NAMES: Record<ShapeType, string> = {
  rect: "Rectangle",
  circle: "Circle",
  arrow: "Arrow",
  line: "Line",
  path: "Pen stroke",
  text: "Text",
};

const SHORTCUTS: [string, string][] = [
  ["Select, Pan", "V, H"],
  ["Pen, Rectangle, Circle", "P, R, O"],
  ["Arrow, Line, Text", "A, L, T"],
  ["Eraser, Laser pointer", "E, K"],
  ["Undo, Redo", "Ctrl+Z, Ctrl+Y"],
  ["Select all", "Ctrl+A"],
  ["Copy, Cut, Paste", "Ctrl+C, X, V"],
  ["Duplicate", "Ctrl+D"],
  ["Delete", "Del"],
  ["Nudge (Shift for more)", "Arrow keys"],
  ["Bring to front, Send to back", "Ctrl+], Ctrl+["],
  ["Forward, Backward one step", "], ["],
  ["Show grid, Snap to grid", "G, Shift+G"],
  ["Pan", "Space + drag"],
  ["Zoom", "Wheel or pinch"],
  ["Finish typing", "Esc"],
];

async function startBoard(roomId: string): Promise<void> {
  const displayName = await ensureName();
  $("app").hidden = false;
  document.title = `${roomId} · LiveBoard`;

  const canvas = $<HTMLCanvasElement>("board");

  // The text editor needs the engine and the renderer's view, which are
  // created after it, so it looks them up lazily.
  let text!: TextEditing;
  let refreshPanel: () => void = () => {};
  let panelQueued = false;
  const queuePanel = () => {
    if (panelQueued) return;
    panelQueued = true;
    requestAnimationFrame(() => {
      panelQueued = false;
      refreshPanel();
    });
  };

  const conn = new Connection(
    socketUrl(),
    {
      roomId,
      displayName,
      token: getToken(),
      password: sessionStorage.getItem(`lb.pw.${roomId}`) ?? undefined,
    },
    {
      measure: measureText,
      onChange: queuePanel, // a remote edit or an undo can change the selected shapes
      onRemoteText: (id, op) => text.applyRemote(id, op),
      onDesync: (why) => console.warn("text revisions disagree:", why),
    },
  );
  const engine = conn.engine;
  const board = new Board(engine);
  const renderer = new CanvasRenderer(canvas, board);
  const history = new History(engine);
  text = new TextEditing(canvas, () => renderer.view, () => engine);
  const input = new InputHandler(canvas, board, renderer, engine, history, conn, text);

  // ---- canvas size, sharp on high-resolution screens
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    renderer.dpr = dpr;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  };
  fit();
  window.addEventListener("resize", fit);
  // Text is measured in the handwriting font; measure again once it has loaded.
  void document.fonts.load("24px Caveat").then(() => engine.remeasure());

  // ---- static icons
  setIcon("menu-btn", "menu");
  setIcon("react-btn", "smile", 21);
  setIcon("zoom-out", "minus", 18);
  setIcon("zoom-in", "plus", 18);
  setIcon("undo-btn", "undo", 19);
  setIcon("redo-btn", "redo", 19);
  setIcon("help-btn", "help", 21);
  $("board-name").textContent = roomId;

  // ---- the tool tray
  const tray = $("tray");
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  for (const spec of TOOLS) {
    if (spec === "sep") {
      const sep = document.createElement("span");
      sep.className = "tray-sep";
      tray.appendChild(sep);
      continue;
    }
    const b = document.createElement("button");
    b.className = "tool";
    b.type = "button";
    b.dataset.tip = `${spec.label}  ${spec.key}`;
    b.setAttribute("aria-label", `${spec.label} (${spec.key})`);
    b.innerHTML = icon(spec.icon, 22) + `<span class="key">${spec.key}</span>`;
    b.addEventListener("click", () => (input.tool = spec.tool));
    tray.appendChild(b);
    toolButtons.set(spec.tool, b);
  }
  input.onToolChange = (tool) => {
    for (const [t, b] of toolButtons) b.setAttribute("aria-pressed", String(t === tool));
    canvas.style.cursor = tool === "hand" ? "grab" : tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
    refreshPanel();
  };
  input.tool = "select";

  // ---- the style panel
  const panel = new StylePanel({
    change: (change) => input.setStyle(change),
    act: (action: PanelAction) => {
      if (action === "duplicate") input.duplicate();
      else if (action === "delete") input.deleteSelection();
      else input.reorder(action);
      refreshPanel();
    },
  });
  document.body.appendChild(panel.el);

  refreshPanel = () => {
    const shapes = input.selectedShapes();
    let model: PanelModel | null = null;
    if (shapes.length > 0) {
      model = {
        title: shapes.length === 1 ? TYPE_NAMES[shapes[0].type] : `${shapes.length} selected`,
        keys: keysFor(shapes.map((s) => s.type)),
        values: summarize(shapes),
        hasSelection: true,
      };
    } else {
      const draws = DRAWS[input.tool];
      if (draws) {
        model = {
          title: `New ${draws.noun}`,
          keys: keysFor([draws.type]),
          values: input.look as unknown as Partial<Record<LookKey, unknown>>,
          hasSelection: false,
        };
      }
    }
    panel.render(model);
  };
  input.onSelect = refreshPanel;
  refreshPanel();

  // ---- connection status, accent colour, people
  const dot = $("status-dot");
  const statusText = $("status-text");
  const renderStatus = () => {
    const pending = engine.pendingCount;
    dot.className = `dot ${conn.status}`;
    statusText.textContent =
      conn.status === "online"
        ? ""
        : conn.status === "connecting"
          ? "Connecting…"
          : pending > 0
            ? `Offline, ${pending} change${pending === 1 ? "" : "s"} waiting`
            : "Offline";
    $("board-title").title =
      conn.status === "online" ? "Connected" : "Your edits are kept here and sync when you reconnect.";
  };
  conn.onStatus = () => {
    if (conn.me) {
      setAccent(conn.me.color);
      renderer.accent = conn.me.color;
    }
    renderStatus();
  };
  setInterval(renderStatus, 500);
  renderStatus();
  input.laserColor = () => conn.me?.color ?? "#e03131";

  const people = $("people");
  const renderPeople = (users: PresenceUser[]) => {
    people.replaceChildren();
    const sorted = [...users].sort((a, b) => Number(b.clientId === conn.clientId) - Number(a.clientId === conn.clientId));
    for (const u of sorted.slice(0, 5)) {
      const a = document.createElement("div");
      a.className = "avatar" + (u.clientId === conn.clientId ? " me" : "");
      a.style.setProperty("--c", u.color);
      a.title = u.clientId === conn.clientId ? `${u.displayName} (you)` : u.displayName;
      a.textContent = (u.displayName.trim()[0] ?? "?").toUpperCase();
      people.appendChild(a);
    }
    if (sorted.length > 5) {
      const more = document.createElement("div");
      more.className = "avatar more";
      more.textContent = `+${sorted.length - 5}`;
      more.title = sorted.slice(5).map((u) => u.displayName).join(", ");
      people.appendChild(more);
    }
  };
  conn.onPresence = renderPeople;

  const colourOf = (clientId: string) => conn.users.find((u) => u.clientId === clientId)?.color ?? "#888888";
  const nameOf = (clientId: string) => conn.users.find((u) => u.clientId === clientId)?.displayName ?? "Someone";

  conn.onCursor = (c) => {
    if (c.laser) {
      renderer.addLaserPoint(c.clientId, c.x, c.y, colourOf(c.clientId));
      return;
    }
    renderer.cursors.set(c.clientId, {
      x: c.x,
      y: c.y,
      name: nameOf(c.clientId),
      color: colourOf(c.clientId),
      seen: performance.now(),
    });
  };

  // ---- reactions float up from where the sender's pointer was
  let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  window.addEventListener("pointermove", (e) => (lastPointer = { x: e.clientX, y: e.clientY }));
  const floatReaction = (emoji: string, x: number, y: number, who: string, colour: string) => {
    const el = document.createElement("div");
    el.className = "float";
    el.style.left = `${x - 24}px`;
    el.style.top = `${y - 40}px`;
    el.style.setProperty("--c", colour);
    el.innerHTML = `<span class="emoji"></span><span class="who"></span>`;
    (el.querySelector(".emoji") as HTMLElement).textContent = emoji;
    (el.querySelector(".who") as HTMLElement).textContent = who;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2300);
  };
  conn.onReaction = ({ clientId, emoji }) => {
    const cursor = renderer.cursors.get(clientId);
    const v = renderer.view;
    const at = cursor
      ? { x: cursor.x * v.zoom + v.panX, y: cursor.y * v.zoom + v.panY }
      : { x: window.innerWidth / 2 + (Math.random() - 0.5) * 240, y: window.innerHeight * 0.55 };
    floatReaction(emoji, at.x, at.y, nameOf(clientId), colourOf(clientId));
  };

  const reactionsPop = $("reactions-pop");
  for (const emoji of REACTIONS) {
    const b = document.createElement("button");
    b.className = "reaction";
    b.textContent = emoji;
    b.setAttribute("aria-label", `React with ${emoji}`);
    b.addEventListener("click", () => {
      conn.sendReaction(emoji);
      floatReaction(emoji, lastPointer.x, lastPointer.y, "You", conn.me?.color ?? "#888888");
      reactionsPop.hidden = true;
    });
    reactionsPop.appendChild(b);
  }
  $("react-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("menu").hidden = true;
    reactionsPop.hidden = !reactionsPop.hidden;
  });

  // ---- zoom, undo, help
  const view = renderer.view;
  const zoomLabel = $("zoom-level");
  const showZoom = () => (zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`);
  const zoomAround = (factor: number) => {
    // Zoom about the middle of the screen.
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const wx = (cx - view.panX) / view.zoom;
    const wy = (cy - view.panY) / view.zoom;
    view.zoom = Math.min(5, Math.max(0.1, view.zoom * factor));
    view.panX = cx - wx * view.zoom;
    view.panY = cy - wy * view.zoom;
    showZoom();
  };
  input.onViewChange = showZoom;
  showZoom();
  $("zoom-in").addEventListener("click", () => zoomAround(1.25));
  $("zoom-out").addEventListener("click", () => zoomAround(0.8));
  zoomLabel.addEventListener("click", () => {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    showZoom();
  });
  $("undo-btn").addEventListener("click", () => input.undo());
  $("redo-btn").addEventListener("click", () => input.redo());

  const showHelp = () => {
    const body = document.createElement("div");
    body.className = "shortcuts";
    for (const [what, keys] of SHORTCUTS) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = what;
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      row.append(label, kbd);
      body.appendChild(row);
    }
    showInfo("Keyboard shortcuts", body);
  };
  $("help-btn").addEventListener("click", showHelp);
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (e.key === "?" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) showHelp();
  });

  // ---- sharing and export
  const shapesNow = () => [...engine.shapes.values()];
  const share = async () => {
    await navigator.clipboard.writeText(location.href.split("?")[0]).catch(() => {});
    toast("Link copied. Anyone with it can draw here.");
  };
  $("share-btn").addEventListener("click", share);

  // ---- grid and snapping
  const setGrid = (on: boolean) => {
    renderer.showGrid = on;
    localStorage.setItem("lb.grid", on ? "1" : "0");
    paintMenu();
  };
  const setSnap = (on: boolean) => {
    input.snap = on;
    localStorage.setItem("lb.snap", on ? "1" : "0");
    toast(on ? "Snapping to the grid" : "Snapping off");
    paintMenu();
  };
  renderer.showGrid = localStorage.getItem("lb.grid") !== "0";
  input.snap = localStorage.getItem("lb.snap") === "1";
  input.onGridKey = (which) => (which === "grid" ? setGrid(!renderer.showGrid) : setSnap(!input.snap));

  // ---- the menu
  const menu = $("menu");
  const empty = () => engine.shapes.size === 0;
  const notEmpty = (fn: () => void | Promise<void>) => async () => {
    if (empty()) return toast("The board is empty: draw something first.");
    await fn();
  };
  interface MenuItem {
    icon: IconName;
    label: string;
    hint?: string;
    checked?: () => boolean;
    run: () => void | Promise<void>;
  }
  const items: (MenuItem | "sep")[] = [
    { icon: "image", label: "Save as PNG", run: notEmpty(async () => (await exportPng(shapesNow(), roomId), toast("Saved as PNG"))) },
    { icon: "image", label: "Save as PNG, no background", run: notEmpty(async () => (await exportPng(shapesNow(), roomId, { background: null }), toast("Saved as PNG"))) },
    { icon: "download", label: "Save as SVG", run: notEmpty(() => (exportSvg(shapesNow(), roomId), toast("Saved as SVG"))) },
    {
      icon: "duplicate",
      label: "Copy as image",
      run: notEmpty(async () => {
        try {
          await copyPng(shapesNow());
          toast("Copied. Paste it anywhere.");
        } catch {
          toast("Your browser would not let me copy the image.");
        }
      }),
    },
    "sep",
    { icon: "grid", label: "Show grid", hint: "G", checked: () => renderer.showGrid, run: () => setGrid(!renderer.showGrid) },
    { icon: "grid", label: "Snap to grid", hint: "Shift+G", checked: () => input.snap, run: () => setSnap(!input.snap) },
    { icon: "moon", label: "Dark mode", checked: () => theme() === "dark", run: () => setTheme(theme() === "dark" ? "light" : "dark") },
    "sep",
    { icon: "help", label: "Keyboard shortcuts", hint: "?", run: showHelp },
    {
      icon: "user",
      label: getToken() ? "Sign out" : "Sign in",
      run: async () => {
        if (getToken()) signOut();
        else if (!(await signInFlow())) return;
        location.reload(); // rejoin so the server knows who we are
      },
    },
    {
      icon: "user",
      label: "Change your name",
      run: async () => {
        const result = await showDialog({
          title: "Your name",
          message: "This is what other people see next to your cursor.",
          fields: [{ name: "name", label: "Name", value: getName() ?? displayName, required: true }],
          actions: [{ id: "ok", label: "Save", primary: true }],
          cancelable: true,
        });
        if (result) {
          setName(result.values.name.trim().slice(0, 32));
          location.reload();
        }
      },
    },
    {
      icon: "home",
      label: "Back to start",
      run: () => {
        location.href = "/";
      },
    },
  ];
  const menuRows: { item: MenuItem; el: HTMLButtonElement }[] = [];
  for (const item of items) {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const b = document.createElement("button");
    b.className = "menu-item";
    b.type = "button";
    b.setAttribute("role", item.checked ? "menuitemcheckbox" : "menuitem");
    b.innerHTML = `${icon(item.icon, 18)}<span>${item.label}</span><span class="hint"></span>`;
    b.addEventListener("click", async () => {
      menu.hidden = true;
      await item.run();
      paintMenu();
    });
    menu.appendChild(b);
    menuRows.push({ item, el: b });
  }
  function paintMenu(): void {
    for (const { item, el } of menuRows) {
      const hint = el.querySelector(".hint") as HTMLElement;
      if (item.checked) {
        const on = item.checked();
        el.setAttribute("aria-checked", String(on));
        hint.textContent = on ? "On" : item.hint ?? "";
        if (item.label === "Dark mode") setIconOf(el, on ? "sun" : "moon");
      } else hint.textContent = item.hint ?? "";
    }
  }
  const setIconOf = (el: HTMLElement, name: IconName) => {
    const svg = el.querySelector("svg");
    if (svg) svg.outerHTML = icon(name, 18);
  };
  paintMenu();
  $("menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    reactionsPop.hidden = true;
    paintMenu();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !$("menu-btn").contains(t)) menu.hidden = true;
    if (!reactionsPop.contains(t) && !$("react-btn").contains(t)) reactionsPop.hidden = true;
  });

  // ---- password-protected boards
  conn.onRefused = async (code, message) => {
    const closedBoard = code === "bad-room";
    const result = await showDialog({
      title: closedBoard ? "This board can't be opened" : "This board needs a password",
      message: closedBoard ? message : code === "bad-password" ? "That password was wrong. Try again." : message,
      fields: closedBoard ? [] : [{ name: "password", label: "Password", type: "password", required: true }],
      actions: [{ id: "ok", label: closedBoard ? "Back to start" : "Open board", primary: true }],
    });
    if (closedBoard || !result) {
      location.href = "/";
      return;
    }
    sessionStorage.setItem(`lb.pw.${roomId}`, result.values.password);
    conn.setPassword(result.values.password);
  };

  // ---- the empty board invites you in
  const hint = $("hint");
  hint.innerHTML =
    `Pick a tool and start drawing<small>Share the link to draw together</small>` +
    `<svg width="64" height="104" viewBox="0 0 64 104" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M26 6C54 30 56 62 34 96M34 96l-13-14M34 96l17-8"/></svg>`;
  setInterval(() => {
    hint.hidden = !(engine.shapes.size === 0 && !text.editingId);
  }, 300);

  // `?debug` exposes the internals in the console, for demos and testing.
  if (new URLSearchParams(location.search).has("debug")) {
    (window as unknown as Record<string, unknown>).__lb = { conn, engine, renderer, input, history };
  }

  renderer.start();
  conn.start();
}
