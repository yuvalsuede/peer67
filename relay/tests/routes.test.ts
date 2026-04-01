import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { buildApp } from "../src/index.js";
import { BlobStore } from "../src/store.js";
import { RegistryStore } from "../src/registry.js";
import { NotifyHub } from "../src/notify.js";

const VALID_MAILBOX_ID = "a".repeat(64);
const VALID_BLOB = Buffer.from("hello world").toString("base64");

let app: FastifyInstance;
// Shared mock redis — flushed before each test to ensure isolation
const mockRedis = new RedisMock() as unknown as Redis;

beforeEach(async () => {
  await (mockRedis as unknown as { flushall(): Promise<void> }).flushall();
  const store = new BlobStore(mockRedis);
  const registry = new RegistryStore(mockRedis);
  const pub = new RedisMock() as unknown as Redis;
  const sub = new RedisMock() as unknown as Redis;
  const notifyHub = new NotifyHub(pub, sub);
  app = await buildApp({ store, registry, notifyHub });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("PUT /d/:mailboxId", () => {
  it("stores a blob and returns id + expiry", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: { blob: VALID_BLOB },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; expires_at: string }>();
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(typeof body.expires_at).toBe("string");
    expect(() => new Date(body.expires_at)).not.toThrow();
  });

  it("rejects request with missing blob field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid mailbox ID", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/d/not-a-valid-mailbox-id",
      payload: { blob: VALID_BLOB },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /d/:mailboxId", () => {
  it("returns stored blobs", async () => {
    // Store a blob first
    await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: { blob: VALID_BLOB },
    });

    const res = await app.inject({
      method: "GET",
      url: `/d/${VALID_MAILBOX_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ blobs: Array<{ id: string; blob: string; ts: number }> }>();
    expect(Array.isArray(body.blobs)).toBe(true);
    expect(body.blobs.length).toBe(1);
    expect(body.blobs[0].blob).toBe(VALID_BLOB);
  });

  it("supports after query parameter", async () => {
    const before = Date.now() - 1000;

    await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: { blob: VALID_BLOB },
    });

    // Query with after = far future — should return nothing
    const future = Date.now() + 1_000_000;
    const res = await app.inject({
      method: "GET",
      url: `/d/${VALID_MAILBOX_ID}?after=${future}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ blobs: unknown[] }>();
    expect(body.blobs.length).toBe(0);

    // Query with after = past — should return the blob
    const res2 = await app.inject({
      method: "GET",
      url: `/d/${VALID_MAILBOX_ID}?after=${before}`,
    });

    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ blobs: unknown[] }>();
    expect(body2.blobs.length).toBe(1);
  });

  it("returns empty array for unknown mailbox", async () => {
    const unknownId = "b".repeat(64);
    const res = await app.inject({
      method: "GET",
      url: `/d/${unknownId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ blobs: unknown[] }>();
    expect(body.blobs).toEqual([]);
  });
});

describe("DELETE /d/:mailboxId/:blobId", () => {
  it("deletes a blob and returns 204", async () => {
    // Store a blob
    const putRes = await app.inject({
      method: "PUT",
      url: `/d/${VALID_MAILBOX_ID}`,
      payload: { blob: VALID_BLOB },
    });
    const { id } = putRes.json<{ id: string }>();

    const res = await app.inject({
      method: "DELETE",
      url: `/d/${VALID_MAILBOX_ID}/${id}`,
    });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for non-existent blob", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/d/${VALID_MAILBOX_ID}/nonexistent-blob-id`,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("GET /health", () => {
  it("returns ok with service info", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; service: string; version: string; timestamp: string }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("peer67-relay");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.timestamp).toBe("string");
  });
});
