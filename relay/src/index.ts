import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { BlobStore } from "./store.js";
import { RegistryStore } from "./registry.js";
import { registerRegistryRoutes } from "./registry-routes.js";
import { isValidMailboxId } from "./middleware.js";
import { NotifyHub } from "./notify.js";

interface BuildAppOptions {
  redisUrl?: string;
  redis?: Redis;
  redisSub?: Redis;
  store?: BlobStore;
  registry?: RegistryStore;
  notifyHub?: NotifyHub;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors);

  const isMock = opts.redisUrl === "redis://mock" || opts.redis !== undefined;
  const isTest = process.env.NODE_ENV === "test" || isMock;
  if (!isTest) {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
    });
  }

  // Build store — accept pre-built instances, pre-built redis, or create from URL.
  // Only create Redis connections if needed (i.e., any of store/registry/notifyHub is missing).
  let store: BlobStore;
  let registryStore: RegistryStore;
  let notifyHub: NotifyHub;

  const needsRedis =
    opts.store === undefined ||
    opts.registry === undefined ||
    opts.notifyHub === undefined;

  if (needsRedis) {
    let redis: Redis;
    let redisSub: Redis;
    if (opts.redis !== undefined) {
      redis = opts.redis;
      redisSub = opts.redisSub ?? opts.redis;
    } else if (opts.redisUrl === "redis://mock") {
      const { default: RedisMock } = await import("ioredis-mock");
      redis = new RedisMock() as unknown as Redis;
      // ioredis-mock instances share the same in-memory store; create a second instance for sub
      redisSub = new RedisMock() as unknown as Redis;
    } else {
      const { default: Redis } = await import("ioredis");
      redis = new Redis(opts.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379");
      redisSub = new Redis(opts.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379");
    }
    store = opts.store ?? new BlobStore(redis);
    registryStore = opts.registry ?? new RegistryStore(redis);
    notifyHub = opts.notifyHub ?? new NotifyHub(redis, redisSub);
  } else {
    store = opts.store!;
    registryStore = opts.registry!;
    notifyHub = opts.notifyHub!;
  }

  const relayUrl = process.env.RELAY_URL ?? "http://localhost:3967";
  await registerRegistryRoutes(app, registryStore, relayUrl);

  // PUT /d/:mailboxId — store a blob
  app.put<{
    Params: { mailboxId: string };
    Body: { blob?: string };
  }>("/d/:mailboxId", async (request, reply) => {
    const { mailboxId } = request.params;

    if (!isValidMailboxId(mailboxId)) {
      return reply.status(400).send({ error: "Invalid mailbox ID: must be 64 lowercase hex characters" });
    }

    const { blob } = request.body ?? {};
    if (!blob || typeof blob !== "string") {
      return reply.status(400).send({ error: "Missing required field: blob" });
    }

    try {
      const result = await store.put(mailboxId, blob);
      await notifyHub.publish(mailboxId, result.id);
      return reply.status(201).send(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      return reply.status(400).send({ error: message });
    }
  });

  // GET /d/:mailboxId — retrieve blobs
  app.get<{
    Params: { mailboxId: string };
    Querystring: { after?: string };
  }>("/d/:mailboxId", async (request, reply) => {
    const { mailboxId } = request.params;

    if (!isValidMailboxId(mailboxId)) {
      return reply.status(400).send({ error: "Invalid mailbox ID: must be 64 lowercase hex characters" });
    }

    const afterParam = request.query.after;
    const after = afterParam !== undefined ? Number(afterParam) : undefined;

    const blobs = await store.get(mailboxId, after);
    return reply.status(200).send({ blobs });
  });

  // DELETE /d/:mailboxId/:blobId — delete a blob
  app.delete<{
    Params: { mailboxId: string; blobId: string };
  }>("/d/:mailboxId/:blobId", async (request, reply) => {
    const { mailboxId, blobId } = request.params;

    const deleted = await store.del(mailboxId, blobId);
    if (!deleted) {
      return reply.status(404).send({ error: "Blob not found" });
    }

    return reply.status(204).send();
  });

  // GET /subscribe — SSE push notifications
  app.get<{
    Querystring: { mailboxes?: string };
  }>("/subscribe", async (request, reply) => {
    const { mailboxes } = request.query;
    if (!mailboxes) {
      return reply.status(400).send({ error: "mailboxes parameter required" });
    }

    const ids = mailboxes.split(",").filter(isValidMailboxId);
    if (ids.length === 0) {
      return reply.status(400).send({ error: "No valid mailbox IDs" });
    }

    // SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(":ok\n\n");

    // Subscribe to all mailboxes
    for (const id of ids) {
      await notifyHub.subscribe(id, reply.raw);
    }

    // Keepalive every 30s
    const keepalive = setInterval(() => {
      try { reply.raw.write(":ping\n\n"); } catch { clearInterval(keepalive); }
    }, 30_000);

    // Cleanup on disconnect
    request.raw.on("close", async () => {
      clearInterval(keepalive);
      for (const id of ids) {
        await notifyHub.unsubscribe(id, reply.raw);
      }
    });
  });

  // GET /health
  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({
      ok: true,
      service: "peer67-relay",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

// Run directly when this is the entry point
const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  const port = Number(process.env.PORT ?? 3967);
  const useMock = process.argv.includes("--mock") || process.env.REDIS_URL === "mock";
  const redisUrl = useMock ? "redis://mock" : process.env.REDIS_URL;
  buildApp({ redisUrl }).then((app) => {
    app.listen({ port, host: "0.0.0.0" }, (err, address) => {
      if (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`Relay listening on ${address}\n`);
    });
  });
}
