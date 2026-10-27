import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Store } from "./store";

// Accounts are optional: a board can be joined with just a display name.
// An account lets you own boards and list them later.

export interface AuthService {
  register(email: string, password: string, displayName: string): Promise<{ token: string; displayName: string } | { error: string }>;
  login(email: string, password: string): Promise<{ token: string; displayName: string } | { error: string }>;
  verify(token: string | undefined): { userId: string; displayName: string } | undefined;
  hashPassword(password: string): Promise<string>;
  checkPassword(password: string, hash: string): Promise<boolean>;
}

// A secret that survives restarts, so tokens stay valid. Set JWT_SECRET to
// manage it yourself; otherwise one is generated and kept next to the database.
function loadSecret(file: string): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function createAuth(store: Store, secretFile: string): AuthService {
  const secret = loadSecret(secretFile);
  const sign = (userId: string, displayName: string) =>
    jwt.sign({ sub: userId, name: displayName }, secret, { expiresIn: "30d" });

  return {
    async register(email, password, displayName) {
      email = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Enter a valid email address." };
      if (password.length < 8) return { error: "Password must be at least 8 characters." };
      displayName = displayName.trim().slice(0, 32) || email.split("@")[0];
      const id = crypto.randomUUID();
      const ok = await store.createUser({ id, email, displayName, passwordHash: await bcrypt.hash(password, 10) });
      if (!ok) return { error: "That email is already registered." };
      return { token: sign(id, displayName), displayName };
    },
    async login(email, password) {
      const user = await store.findUserByEmail(email.trim().toLowerCase());
      // Same message for "no such user" and "wrong password" so the response
      // doesn't reveal which emails are registered.
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) return { error: "Wrong email or password." };
      return { token: sign(user.id, user.displayName), displayName: user.displayName };
    },
    verify(token) {
      if (!token) return undefined;
      try {
        const payload = jwt.verify(token, secret) as { sub: string; name: string };
        return { userId: payload.sub, displayName: payload.name };
      } catch {
        return undefined;
      }
    },
    hashPassword: (password) => bcrypt.hash(password, 10),
    checkPassword: (password, hash) => bcrypt.compare(password, hash),
  };
}
