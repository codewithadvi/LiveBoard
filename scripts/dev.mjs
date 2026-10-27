// `npm run dev`: starts the realtime server and the web app together, no Docker needed.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const children = [
  spawn(node, [join(root, "node_modules/tsx/dist/cli.mjs"), "watch", "server/src/index.ts"], {
    cwd: root,
    stdio: "inherit",
  }),
  spawn(node, [join(root, "node_modules/vite/bin/vite.js")], {
    cwd: join(root, "client"),
    stdio: "inherit",
  }),
];

console.log("\nLiveBoard dev: server on http://localhost:8080, app on http://localhost:5173\n");

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => code && stop());
