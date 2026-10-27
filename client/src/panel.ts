import { icon, type IconName } from "./icons";
import { MIXED, type Look, type LookKey } from "./look";

export type PanelAction = "front" | "forward" | "backward" | "back" | "duplicate" | "delete";

export interface PanelModel {
  title: string; // "Rectangle", "3 selected", "New shapes"
  keys: Set<LookKey>; // which controls to show
  values: Partial<Record<LookKey, unknown>>; // MIXED where the selection disagrees
  hasSelection: boolean; // layer / duplicate / delete only make sense with a selection
}

export const STROKE_COLORS = ["#1b2236", "#e03131", "#f08c00", "#2f9e44", "#1971c2", "#9c36b5"];
export const FILL_COLORS = ["#ffa8a8", "#ffd43b", "#8ce99a", "#74c0fc", "#b197fc", "#faa2c1"];

interface Option {
  value: string | number;
  title: string;
  icon?: IconName;
  label?: string;
  font?: string; // CSS font for a text sample
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html) e.innerHTML = html;
  return e;
}

interface Control {
  row: HTMLElement;
  update(value: unknown): void;
}

// The floating style panel. It never changes shapes itself: it reports what
// the user chose through `hooks`, and shows whatever model it is given.
export class StylePanel {
  readonly el = el("aside", "panel");
  private title = el("div", "panel-title");
  private controls = new Map<LookKey, Control>();
  private actions = el("div", "panel-actions");

  constructor(private hooks: { change(change: Partial<Look>): void; act(action: PanelAction): void }) {
    this.el.hidden = true;
    this.el.appendChild(this.title);

    this.add("stroke", "Stroke", this.swatches("stroke", STROKE_COLORS, false));
    this.add("fill", "Fill", this.swatches("fill", FILL_COLORS, true));
    this.add("fillStyle", "Fill pattern", this.segmented("fillStyle", [
      { value: "hachure", title: "Hatched", icon: "hatch" },
      { value: "cross", title: "Cross-hatched", icon: "cross" },
      { value: "solid", title: "Solid", icon: "solid" },
    ]));
    this.add("strokeWidth", "Line weight", this.segmented("strokeWidth", [
      { value: 1, title: "Thin", icon: "w1" },
      { value: 2, title: "Regular", icon: "w2" },
      { value: 4, title: "Bold", icon: "w4" },
      { value: 6, title: "Heavy", icon: "w6" },
    ]));
    this.add("strokeStyle", "Line style", this.segmented("strokeStyle", [
      { value: "solid", title: "Solid", icon: "solidLine" },
      { value: "dashed", title: "Dashed", icon: "dashed" },
      { value: "dotted", title: "Dotted", icon: "dotted" },
    ]));
    this.add("roughness", "Sketchiness", this.segmented("roughness", [
      { value: 0, title: "Clean", icon: "clean" },
      { value: 1, title: "Sketchy", icon: "sketchy" },
      { value: 2, title: "Wild", icon: "wild" },
    ]));
    this.add("edges", "Corners", this.segmented("edges", [
      { value: "sharp", title: "Sharp", icon: "sharp" },
      { value: "round", title: "Rounded", icon: "round" },
    ]));
    this.add("fontFamily", "Font", this.segmented("fontFamily", [
      { value: "hand", title: "Handwritten", label: "Aa", font: '"Caveat", cursive' },
      { value: "sans", title: "Clean", label: "Aa", font: '"Bricolage Grotesque Variable", sans-serif' },
      { value: "mono", title: "Code", label: "Aa", font: "ui-monospace, Consolas, monospace" },
    ]));
    this.add("fontSize", "Text size", this.segmented("fontSize", [
      { value: 20, title: "Small", label: "S" },
      { value: 28, title: "Medium", label: "M" },
      { value: 40, title: "Large", label: "L" },
      { value: 56, title: "Extra large", label: "XL" },
    ]));
    this.add("opacity", "Opacity", this.slider());

    this.buildActions();
    this.el.appendChild(this.actions);
  }

  render(model: PanelModel | null): void {
    if (!model || model.keys.size === 0) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.title.textContent = model.title;
    const fillShown = model.values.fill !== "none";
    for (const [key, control] of this.controls) {
      const show = model.keys.has(key) && (key !== "fillStyle" || fillShown);
      control.row.hidden = !show;
      if (show) control.update(model.values[key]);
    }
    this.actions.hidden = !model.hasSelection;
  }

  // ---- building the controls -----------------------------------------------------

  private add(key: LookKey, label: string, control: Control): void {
    const row = control.row;
    const heading = el("div", "row-label", label);
    row.prepend(heading);
    this.controls.set(key, control);
    this.el.appendChild(row);
  }

  private swatches(key: "stroke" | "fill", colors: string[], withNone: boolean): Control {
    const row = el("div", "row");
    const wrap = el("div", "swatches");
    const buttons = new Map<string, HTMLButtonElement>();
    const make = (value: string, title: string) => {
      const b = el("button", "swatch");
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      if (value === "none") b.classList.add("none");
      else b.style.setProperty("--c", value);
      b.addEventListener("click", () => this.hooks.change({ [key]: value } as Partial<Look>));
      buttons.set(value, b);
      wrap.appendChild(b);
    };
    if (withNone) make("none", "No fill");
    for (const c of colors) make(c, c);

    // Any colour at all.
    const custom = el("label", "swatch custom");
    custom.title = "Pick any colour";
    const picker = el("input");
    picker.type = "color";
    picker.addEventListener("change", () => this.hooks.change({ [key]: picker.value } as Partial<Look>));
    custom.appendChild(picker);
    wrap.appendChild(custom);
    row.appendChild(wrap);

    return {
      row,
      update: (value) => {
        const mixed = value === MIXED;
        row.classList.toggle("mixed", mixed);
        for (const [v, b] of buttons) b.classList.toggle("on", !mixed && value === v);
        const isCustom = !mixed && typeof value === "string" && value !== "none" && !buttons.has(value);
        custom.classList.toggle("on", isCustom);
        if (isCustom) {
          custom.style.setProperty("--c", value as string);
          picker.value = value as string;
        } else custom.style.removeProperty("--c");
      },
    };
  }

  private segmented(key: LookKey, options: Option[]): Control {
    const row = el("div", "row");
    const group = el("div", "segmented");
    group.setAttribute("role", "group");
    const buttons = new Map<string | number, HTMLButtonElement>();
    for (const o of options) {
      const b = el("button", "seg", o.icon ? icon(o.icon, 20) : "");
      b.type = "button";
      b.title = o.title;
      b.setAttribute("aria-label", o.title);
      if (o.label) {
        b.textContent = o.label;
        if (o.font) b.style.fontFamily = o.font;
      }
      b.addEventListener("click", () => this.hooks.change({ [key]: o.value } as Partial<Look>));
      buttons.set(o.value, b);
      group.appendChild(b);
    }
    row.appendChild(group);
    return {
      row,
      update: (value) => {
        row.classList.toggle("mixed", value === MIXED);
        for (const [v, b] of buttons) b.classList.toggle("on", value !== MIXED && v === value);
      },
    };
  }

  private slider(): Control {
    const row = el("div", "row");
    const input = el("input", "slider");
    input.type = "range";
    input.min = "0.1";
    input.max = "1";
    input.step = "0.1";
    input.setAttribute("aria-label", "Opacity");
    input.addEventListener("change", () => this.hooks.change({ opacity: Number(input.value) }));
    row.appendChild(input);
    return {
      row,
      update: (value) => {
        row.classList.toggle("mixed", value === MIXED);
        if (typeof value === "number") input.value = String(value);
      },
    };
  }

  private buildActions(): void {
    const layers = el("div", "action-group");
    const make = (name: IconName, title: string, action: PanelAction, parent: HTMLElement, danger = false) => {
      const b = el("button", "act" + (danger ? " danger" : ""), icon(name, 19));
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", () => this.hooks.act(action));
      parent.appendChild(b);
    };
    make("back", "Send to back (Ctrl+[)", "back", layers);
    make("backward", "Back one step ([)", "backward", layers);
    make("forward", "Forward one step (])", "forward", layers);
    make("front", "Bring to front (Ctrl+])", "front", layers);
    const edit = el("div", "action-group");
    make("duplicate", "Duplicate (Ctrl+D)", "duplicate", edit);
    make("trash", "Delete (Del)", "delete", edit, true);
    this.actions.append(layers, edit);
  }
}
