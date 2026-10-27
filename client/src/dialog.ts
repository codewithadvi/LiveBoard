export interface Field {
  name: string;
  label: string;
  type?: string;
  value?: string;
  placeholder?: string;
  required?: boolean;
}

export interface Action {
  id: string;
  label: string;
  primary?: boolean;
}

export interface DialogResult {
  action: string;
  values: Record<string, string>;
}

// A small modal form. Resolves with the pressed button and the field values,
// or null if the user dismissed it (when `cancelable`).
export function showDialog(opts: {
  title: string;
  message?: string;
  error?: string;
  fields: Field[];
  actions: Action[];
  cancelable?: boolean;
}): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal";

    const title = document.createElement("h2");
    title.textContent = opts.title;
    form.appendChild(title);

    if (opts.message) {
      const p = document.createElement("p");
      p.textContent = opts.message;
      form.appendChild(p);
    }
    if (opts.error) {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = opts.error;
      form.appendChild(p);
    }

    const inputs = new Map<string, HTMLInputElement>();
    for (const f of opts.fields) {
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = document.createElement("input");
      input.name = f.name;
      input.type = f.type ?? "text";
      input.value = f.value ?? "";
      input.placeholder = f.placeholder ?? "";
      input.required = f.required ?? false;
      input.autocomplete = f.type === "password" ? "current-password" : "off";
      label.appendChild(input);
      form.appendChild(label);
      inputs.set(f.name, input);
    }

    const buttons = document.createElement("div");
    buttons.className = "modal-actions";
    let chosen = opts.actions.find((a) => a.primary)?.id ?? opts.actions[0].id;
    for (const action of opts.actions) {
      const b = document.createElement("button");
      b.type = "submit";
      b.textContent = action.label;
      if (action.primary) b.className = "primary";
      b.addEventListener("click", () => (chosen = action.id));
      buttons.appendChild(b);
    }
    if (opts.cancelable) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => finish(null));
      buttons.appendChild(cancel);
    }
    form.appendChild(buttons);

    const finish = (result: DialogResult | null) => {
      backdrop.remove();
      resolve(result);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      for (const [name, input] of inputs) values[name] = input.value;
      finish({ action: chosen, values });
    });

    backdrop.appendChild(form);
    if (opts.cancelable) {
      backdrop.addEventListener("keydown", (e) => e.key === "Escape" && finish(null));
      backdrop.addEventListener("pointerdown", (e) => e.target === backdrop && finish(null));
    }
    document.body.appendChild(backdrop);
    inputs.values().next().value?.focus();
  });
}

// A read-only dialog (the keyboard shortcut list). Closes on Escape, a click
// outside, or the button.
export function showInfo(title: string, body: HTMLElement): void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const box = document.createElement("div");
  box.className = "modal wide";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const close = document.createElement("button");
  close.className = "primary";
  close.textContent = "Done";
  actions.appendChild(close);
  box.append(heading, body, actions);
  backdrop.appendChild(box);

  const done = () => backdrop.remove();
  close.addEventListener("click", done);
  backdrop.addEventListener("pointerdown", (e) => e.target === backdrop && done());
  backdrop.addEventListener("keydown", (e) => e.key === "Escape" && done());
  document.body.appendChild(backdrop);
  close.focus();
}
