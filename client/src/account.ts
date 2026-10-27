import { showDialog } from "./dialog";

const TOKEN_KEY = "lb.token";
const NAME_KEY = "lb.name";

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? undefined;
export const getName = () => localStorage.getItem(NAME_KEY) ?? undefined;
export const setName = (name: string) => localStorage.setItem(NAME_KEY, name);

export function signOut(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function call(path: string, body: object): Promise<{ token?: string; displayName?: string; error?: string }> {
  const res = await fetch(path, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}

// Asks for a display name the first time, then remembers it.
export async function ensureName(): Promise<string> {
  const saved = getName();
  if (saved) return saved;
  const result = await showDialog({
    title: "Welcome to LiveBoard",
    message: "Pick a name so others can see who you are.",
    fields: [{ name: "name", label: "Display name", required: true, placeholder: "Ada" }],
    actions: [{ id: "ok", label: "Continue", primary: true }],
  });
  const name = (result?.values.name.trim() || "Guest").slice(0, 32);
  setName(name);
  return name;
}

// Sign in or create an account. Returns true if the user is now signed in.
export async function signInFlow(): Promise<boolean> {
  let error: string | undefined;
  for (;;) {
    const result = await showDialog({
      title: "Sign in",
      message: "An account lets you list the boards you created.",
      error,
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        { name: "password", label: "Password (8+ characters)", type: "password", required: true },
        { name: "displayName", label: "Display name (new accounts)", value: getName() ?? "" },
      ],
      actions: [
        { id: "login", label: "Sign in", primary: true },
        { id: "register", label: "Create account" },
      ],
      cancelable: true,
    });
    if (!result) return false;
    const { email, password, displayName } = result.values;
    const reply = await call(result.action === "register" ? "/api/register" : "/api/login", {
      email,
      password,
      displayName,
    });
    if (reply.token) {
      localStorage.setItem(TOKEN_KEY, reply.token);
      if (reply.displayName) setName(reply.displayName);
      return true;
    }
    error = reply.error ?? "Something went wrong.";
  }
}

export async function myBoards(): Promise<{ id: string; createdAt: string }[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetch("/api/boards", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  return ((await res.json()) as { boards: { id: string; createdAt: string }[] }).boards;
}
