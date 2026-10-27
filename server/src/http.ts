import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { AuthService } from "./auth";
import type { Hub } from "./hub";
import type { Store } from "./store";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

function readJson(req: IncomingMessage, limit = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Small HTTP API for accounts, plus the built web app when it exists, so that
// `npm start` serves the whole product from one port.
export function createHttpHandler(opts: { auth: AuthService; store: Store; hub: Hub; staticDir: string }) {
  const { auth, store, hub, staticDir } = opts;
  const root = resolve(staticDir);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/health") return json(res, 200, { ok: true, ...hub.stats(), store: store.kind });

      if (req.method === "POST" && (url.pathname === "/api/register" || url.pathname === "/api/login")) {
        const body = await readJson(req);
        const email = String(body.email ?? "");
        const password = String(body.password ?? "");
        const result =
          url.pathname === "/api/register"
            ? await auth.register(email, password, String(body.displayName ?? ""))
            : await auth.login(email, password);
        return json(res, "error" in result ? 400 : 200, result);
      }

      if (req.method === "GET" && url.pathname === "/api/boards") {
        const user = auth.verify((req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!user) return json(res, 401, { error: "Sign in first." });
        return json(res, 200, { boards: await store.roomsOwnedBy(user.userId) });
      }

      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." });

      // Static files (only present after `npm run build`).
      if (!existsSync(root)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("LiveBoard server is running. Start the web app with `npm run dev:client`, or run `npm run build` first.");
      }
      let file = normalize(join(root, decodeURIComponent(url.pathname)));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        return res.end();
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // /board/abc -> app
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch (e) {
      const message = e instanceof Error ? e.message : "error";
      json(res, message === "body too large" ? 413 : 400, { error: message });
    }
  };
}
