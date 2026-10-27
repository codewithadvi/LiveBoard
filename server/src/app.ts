import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createAuth } from "./auth";
import { createRedisBus, LocalBus, ResilientBus, type Bus } from "./bus";
import { createHttpHandler } from "./http";
import { Hub } from "./hub";
import { createStore, type Store } from "./store";

export interface AppConfig {
  port: number;
  dataDir: string;
  serverId?: string;
  databaseUrl?: string;
  sqliteFile?: string;
  redisUrl?: string;
  staticDir?: string;
  // Tests inject these to share one database / bus between several servers.
  store?: Store;
  bus?: Bus;
  quiet?: boolean;
  timing?: { primaryTtlMs: number; tickMs: number };
}

export interface App {
  port: number;
  serverId: string;
  hub: Hub;
  store: Store;
  bus: Bus;
  killAbruptly(): Promise<void>;
  close(): Promise<void>;
}

export async function startApp(config: AppConfig): Promise<App> {
  const serverId = config.serverId ?? `srv-${randomBytes(3).toString("hex")}`;
  const log = config.quiet ? () => {} : console.log;

  const ownStore = !config.store;
  const store =
    config.store ??
    (await createStore({
      databaseUrl: config.databaseUrl,
      sqliteFile: config.sqliteFile ?? join(config.dataDir, "liveboard.db"),
    }));
  if (ownStore) await store.init();

  const ownBus = !config.bus;
  let bus: Bus = config.bus ?? new LocalBus();
  if (!config.bus && config.redisUrl) bus = new ResilientBus(await createRedisBus(config.redisUrl), log);

  const auth = createAuth(store, join(config.dataDir, "jwt-secret"));
  const hub = new Hub(serverId, store, bus, auth, log, config.timing);
  const http = createServer(
    createHttpHandler({ auth, store, hub, staticDir: config.staticDir ?? join(config.dataDir, "..", "client", "dist") }),
  );
  const wss = new WebSocketServer({ server: http, maxPayload: 1_000_000 });
  wss.on("connection", (ws) => hub.connect(ws));

  await new Promise<void>((resolve) => http.listen(config.port, resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const stopListening = async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
  };

  return {
    port,
    serverId,
    hub,
    store,
    bus,
    // Like a crash: connections drop and the server stops renewing its lock,
    // but it does not release the room lock or say goodbye.
    async killAbruptly() {
      await hub.crash();
      await stopListening();
    },
    async close() {
      await hub.close();
      await stopListening();
      if (ownBus) await bus.close();
      if (ownStore) await store.close();
    },
  };
}
