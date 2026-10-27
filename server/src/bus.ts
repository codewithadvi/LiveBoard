// How server instances talk to each other. With one server this is just
// in-process function calls (LocalBus). With several, Redis carries the
// messages (RedisBus) and also provides the lock used to pick one "primary"
// server per room.

export type Handler = (message: string) => void;

export interface Bus {
  readonly kind: "local" | "redis";
  healthy(): boolean;
  publish(channel: string, message: string): Promise<void>;
  // Returns a function that unsubscribes.
  subscribe(channel: string, handler: Handler): Promise<() => void>;
  // A lock with an expiry. Whoever holds it keeps it only by renewing it.
  claim(key: string, owner: string, ttlMs: number): Promise<boolean>;
  renew(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
  close(): Promise<void>;
}

// ---- in-process ----------------------------------------------------------------

export class LocalBus implements Bus {
  readonly kind = "local" as const;
  private handlers = new Map<string, Set<Handler>>();
  private locks = new Map<string, { owner: string; expires: number }>();

  healthy(): boolean {
    return true;
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const h of [...(this.handlers.get(channel) ?? [])]) h(message);
  }

  async subscribe(channel: string, handler: Handler): Promise<() => void> {
    let set = this.handlers.get(channel);
    if (!set) this.handlers.set(channel, (set = new Set()));
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async claim(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const held = this.locks.get(key);
    if (held && held.expires > Date.now() && held.owner !== owner) return false;
    this.locks.set(key, { owner, expires: Date.now() + ttlMs });
    return true;
  }

  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    const held = this.locks.get(key);
    if (!held || held.owner !== owner || held.expires <= Date.now()) return false;
    held.expires = Date.now() + ttlMs;
    return true;
  }

  async release(key: string, owner: string): Promise<void> {
    if (this.locks.get(key)?.owner === owner) this.locks.delete(key);
  }

  async close(): Promise<void> {}
}

// ---- Redis ---------------------------------------------------------------------

// Delete / extend a lock only if we still own it (compare-and-act must be atomic).
const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function createRedisBus(url: string): Promise<Bus> {
  const { Redis } = await import("ioredis");
  const opts = {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: 1000,
    retryStrategy: () => 1000,
  };
  const pub = new Redis(url, opts);
  const sub = new Redis(url, { ...opts, enableOfflineQueue: true });
  // Without a listener, a connection error is thrown as an unhandled event.
  pub.on("error", () => {});
  sub.on("error", () => {});
  const handlers = new Map<string, Set<Handler>>();
  sub.on("message", (channel: string, message: string) => {
    for (const h of handlers.get(channel) ?? []) h(message);
  });
  // Don't let a missing Redis hold up startup: ioredis keeps retrying in the
  // background, and ResilientBus runs in degraded mode until it connects.
  await Promise.race([
    Promise.allSettled([pub.connect(), sub.connect()]),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);

  return {
    kind: "redis",
    healthy: () => pub.status === "ready" && sub.status === "ready",
    async publish(channel, message) {
      await pub.publish(channel, message);
    },
    async subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (!set) {
        handlers.set(channel, (set = new Set()));
        const subscribed = sub.subscribe(channel);
        // While Redis is down the command would wait for it; ioredis re-subscribes
        // by itself on reconnect, so only wait when the connection is up.
        if (sub.status === "ready") await subscribed;
        else subscribed.catch(() => {});
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) {
          handlers.delete(channel);
          void sub.unsubscribe(channel).catch(() => {});
        }
      };
    },
    async claim(key, owner, ttlMs) {
      return (await pub.set(key, owner, "PX", ttlMs, "NX")) === "OK";
    },
    async renew(key, owner, ttlMs) {
      return Number(await pub.eval(RENEW_LUA, 1, key, owner, String(ttlMs))) === 1;
    },
    async release(key, owner) {
      await pub.eval(RELEASE_LUA, 1, key, owner);
    },
    async close() {
      pub.disconnect();
      sub.disconnect();
    },
  };
}

// ---- degraded mode -----------------------------------------------------------------

// If Redis goes away the server keeps working on its own: messages stay
// in-process and this server simply treats itself as primary for its rooms.
// (Clients on other servers are cut off from each other until Redis returns.)
export class ResilientBus implements Bus {
  readonly kind = "redis" as const;
  private local = new LocalBus();
  private wasHealthy = true;

  constructor(
    private redis: Bus,
    private log: (msg: string) => void = console.warn,
  ) {}

  private active(): Bus {
    const ok = this.redis.healthy();
    if (ok !== this.wasHealthy) {
      this.wasHealthy = ok;
      this.log(ok ? "redis recovered: back to multi-server mode" : "redis unavailable: degraded single-node mode");
    }
    return ok ? this.redis : this.local;
  }

  healthy(): boolean {
    return this.redis.healthy();
  }

  // Subscribe on both, so a handler hears messages whichever bus is carrying them.
  async subscribe(channel: string, handler: Handler): Promise<() => void> {
    const offLocal = await this.local.subscribe(channel, handler);
    let offRedis: () => void = () => {};
    try {
      offRedis = await this.redis.subscribe(channel, handler);
    } catch {
      // Redis is down right now; the local subscription still works.
    }
    return () => {
      offLocal();
      offRedis();
    };
  }

  publish(channel: string, message: string): Promise<void> {
    return this.active().publish(channel, message);
  }

  async claim(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.active().claim(key, owner, ttlMs).catch(() => this.local.claim(key, owner, ttlMs));
  }

  async renew(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.active().renew(key, owner, ttlMs).catch(() => this.local.renew(key, owner, ttlMs));
  }

  async release(key: string, owner: string): Promise<void> {
    await this.local.release(key, owner);
    await this.redis.release(key, owner).catch(() => {});
  }

  close(): Promise<void> {
    return this.redis.close();
  }
}
