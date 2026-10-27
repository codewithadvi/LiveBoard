import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "@liveboard/shared";
import { startApp } from "./app";

// Runs with no setup: SQLite file + in-process bus. Set DATABASE_URL to use
// Postgres, and REDIS_URL to coordinate several servers.
const here = dirname(fileURLToPath(import.meta.url));

const app = await startApp({
  port: Number(process.env.PORT ?? PORT),
  dataDir: process.env.DATA_DIR ?? join(here, "..", "..", "data"),
  serverId: process.env.SERVER_ID,
  databaseUrl: process.env.DATABASE_URL,
  sqliteFile: process.env.SQLITE_FILE,
  redisUrl: process.env.REDIS_URL,
  staticDir: process.env.STATIC_DIR ?? join(here, "..", "..", "client", "dist"),
});

console.log(
  `LiveBoard ${app.serverId} on http://localhost:${app.port}  (storage: ${app.store.kind}, bus: ${app.bus.kind === "redis" ? "redis" : "in-process"})`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)));
}
