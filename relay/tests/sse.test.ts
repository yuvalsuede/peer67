import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import type { ServerResponse } from "node:http";
import { buildApp } from "../src/index.js";
import { BlobStore } from "../src/store.js";
import { RegistryStore } from "../src/registry.js";
import { NotifyHub } from "../src/notify.js";

const VALID_MAILBOX_ID = "a".repeat(64);
const VALID_MAILBOX_ID_2 = "b".repeat(64);
const VALID_BLOB = Buffer.from("hello world").toString("base64");

// ---------------------------------------------------------------------------
// NotifyHub unit tests — test pub/sub mechanics directly
// ---------------------------------------------------------------------------

describe("NotifyHub", () => {
  it("publish delivers event to subscribed response", async () => {
    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    const hub = new NotifyHub(pub, sub);

    const written: string[] = [];
    const mockRes = {
      write: (chunk: string) => { written.push(chunk); },
    } as unknown as ServerResponse;

    await hub.subscribe(VALID_MAILBOX_ID, mockRes);
    await hub.publish(VALID_MAILBOX_ID, "blob-123");

    // Give the event loop a tick for the message listener to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written.length).toBe(1);
    expect(written[0]).toContain("event: blob");
    expect(written[0]).toContain("blob-123");
    expect(written[0]).toContain(VALID_MAILBOX_ID);
  });

  it("publish delivers to multiple subscribers on the same mailbox", async () => {
    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    const hub = new NotifyHub(pub, sub);

    const written1: string[] = [];
    const written2: string[] = [];

    const mockRes1 = { write: (c: string) => { written1.push(c); } } as unknown as ServerResponse;
    const mockRes2 = { write: (c: string) => { written2.push(c); } } as unknown as ServerResponse;

    await hub.subscribe(VALID_MAILBOX_ID, mockRes1);
    await hub.subscribe(VALID_MAILBOX_ID, mockRes2);
    await hub.publish(VALID_MAILBOX_ID, "blob-multi");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written1.length).toBe(1);
    expect(written2.length).toBe(1);
  });

  it("unsubscribe stops delivery to removed response", async () => {
    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    const hub = new NotifyHub(pub, sub);

    const written: string[] = [];
    const mockRes = { write: (c: string) => { written.push(c); } } as unknown as ServerResponse;

    await hub.subscribe(VALID_MAILBOX_ID, mockRes);
    await hub.unsubscribe(VALID_MAILBOX_ID, mockRes);
    await hub.publish(VALID_MAILBOX_ID, "blob-after-unsub");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written.length).toBe(0);
  });

  it("does not deliver to different mailbox subscriber", async () => {
    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    const hub = new NotifyHub(pub, sub);

    const written: string[] = [];
    const mockRes = { write: (c: string) => { written.push(c); } } as unknown as ServerResponse;

    await hub.subscribe(VALID_MAILBOX_ID, mockRes);
    await hub.publish(VALID_MAILBOX_ID_2, "blob-other-mailbox");

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(written.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PUT → notify integration: PUT a blob triggers hub.publish
// ---------------------------------------------------------------------------

describe("PUT /d/:mailboxId notifies hub", () => {
  let app: FastifyInstance;
  let hub: NotifyHub;
  const mockRedis = new RedisMock() as unknown as Redis;

  beforeEach(async () => {
    await (mockRedis as unknown as { flushall(): Promise<void> }).flushall();
    const store = new BlobStore(mockRedis);
    const registry = new RegistryStore(mockRedis);

    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    hub = new NotifyHub(pub, sub);

    app = await buildApp({ store, registry, notifyHub: hub });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("PUT triggers notification to subscribers", async () => {
    const written: string[] = [];
    const mockRes = { write: (c: string) => { written.push(c); } } as unknown as ServerResponse;

    await hub.subscribe(VALID_MAILBOX_ID, mockRes);

    await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: { blob: VALID_BLOB },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(written.length).toBe(1);
    const parsed = JSON.parse(written[0].split("data: ")[1]);
    expect(parsed.mailbox).toBe(VALID_MAILBOX_ID);
    expect(typeof parsed.blob_id).toBe("string");
    expect(typeof parsed.ts).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// GET /subscribe — HTTP endpoint validation tests
// ---------------------------------------------------------------------------

describe("GET /subscribe", () => {
  let app: FastifyInstance;
  let hub: NotifyHub;
  const mockRedis = new RedisMock() as unknown as Redis;

  beforeEach(async () => {
    await (mockRedis as unknown as { flushall(): Promise<void> }).flushall();
    const store = new BlobStore(mockRedis);
    const registry = new RegistryStore(mockRedis);

    const pub = new RedisMock() as unknown as Redis;
    const sub = new RedisMock() as unknown as Redis;
    hub = new NotifyHub(pub, sub);

    app = await buildApp({ store, registry, notifyHub: hub });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects request missing mailboxes param", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/subscribe",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/mailboxes/);
  });

  it("rejects request with only invalid mailbox IDs", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/subscribe?mailboxes=not-valid,also-not-valid",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/valid mailbox/i);
  });

  it("rejects a mix where all IDs are invalid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/subscribe?mailboxes=short,toolong$$$",
    });

    expect(res.statusCode).toBe(400);
  });

  // SSE streaming tests: inject() can't be used for long-lived SSE responses
  // because it waits for the response to complete. Instead, we test the
  // NotifyHub subscription side-effects directly.

  it("accepts valid mailbox ID — hub.subscribe is called for valid IDs", async () => {
    // Spy on the hub to verify subscribe is called
    const subscribedIds: string[] = [];
    const origSubscribe = hub.subscribe.bind(hub);
    hub.subscribe = async (id: string, res: ServerResponse) => {
      subscribedIds.push(id);
      return origSubscribe(id, res);
    };

    // Use a short-circuit: simulate the SSE request via inject with a connection
    // that immediately closes (inject closes after response headers are written).
    // We test that subscribe was attempted with the correct mailbox ID.
    // Because inject closes the connection right away, writeHead triggers then close fires.
    const resPromise = app.inject({
      method: "GET",
      url: `/subscribe?mailboxes=${VALID_MAILBOX_ID}`,
    });

    // Race with a short timeout — the inject may time out on SSE (never-ending response),
    // so just verify the hub was invoked within a reasonable window.
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 200));
    await Promise.race([resPromise.then(() => {}), timeoutPromise]);

    expect(subscribedIds).toContain(VALID_MAILBOX_ID);
  }, 10_000);

  it("accepts multiple valid mailbox IDs — hub.subscribe is called for each", async () => {
    const subscribedIds: string[] = [];
    const origSubscribe = hub.subscribe.bind(hub);
    hub.subscribe = async (id: string, res: ServerResponse) => {
      subscribedIds.push(id);
      return origSubscribe(id, res);
    };

    const resPromise = app.inject({
      method: "GET",
      url: `/subscribe?mailboxes=${VALID_MAILBOX_ID},${VALID_MAILBOX_ID_2}`,
    });

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 200));
    await Promise.race([resPromise.then(() => {}), timeoutPromise]);

    expect(subscribedIds).toContain(VALID_MAILBOX_ID);
    expect(subscribedIds).toContain(VALID_MAILBOX_ID_2);
  }, 10_000);

  it("filters out invalid IDs and subscribes only valid ones", async () => {
    const subscribedIds: string[] = [];
    const origSubscribe = hub.subscribe.bind(hub);
    hub.subscribe = async (id: string, res: ServerResponse) => {
      subscribedIds.push(id);
      return origSubscribe(id, res);
    };

    const resPromise = app.inject({
      method: "GET",
      url: `/subscribe?mailboxes=${VALID_MAILBOX_ID},not-valid-id`,
    });

    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 200));
    await Promise.race([resPromise.then(() => {}), timeoutPromise]);

    expect(subscribedIds).toContain(VALID_MAILBOX_ID);
    expect(subscribedIds).not.toContain("not-valid-id");
  }, 10_000);
});
