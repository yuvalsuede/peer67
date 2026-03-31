import { describe, it, expect, beforeEach } from "vitest";
import IORedisMock from "ioredis-mock";
import { BlobStore } from "../src/store.js";

const VALID_MAILBOX_ID = "a".repeat(64);

function makeBlob(sizeBytes: number): string {
  return "x".repeat(sizeBytes);
}

describe("BlobStore", () => {
  let redis: InstanceType<typeof IORedisMock>;
  let store: BlobStore;

  beforeEach(async () => {
    redis = new IORedisMock();
    await redis.flushall();
    store = new BlobStore(redis as any);
  });

  // ─── put ────────────────────────────────────────────────────────────────────

  describe("put", () => {
    it("stores a blob and returns id + expires_at", async () => {
      const result = await store.put(VALID_MAILBOX_ID, "hello world");

      expect(result.id).toBeTruthy();
      expect(typeof result.id).toBe("string");
      expect(result.expires_at).toBeTruthy();

      // expires_at should be a valid ISO date roughly 24h in the future
      const expiresAt = new Date(result.expires_at);
      const now = Date.now();
      expect(expiresAt.getTime()).toBeGreaterThan(now + 23 * 3600 * 1000);
      expect(expiresAt.getTime()).toBeLessThan(now + 25 * 3600 * 1000);
    });

    it("rejects blobs over 64KB", async () => {
      const bigBlob = makeBlob(65537);
      await expect(store.put(VALID_MAILBOX_ID, bigBlob)).rejects.toThrow(
        /too large/i
      );
    });

    it("accepts blobs exactly at the 64KB limit", async () => {
      const maxBlob = makeBlob(65536);
      const result = await store.put(VALID_MAILBOX_ID, maxBlob);
      expect(result.id).toBeTruthy();
    });

    it("rejects mailbox IDs that are too short", async () => {
      await expect(store.put("abc123", "hello")).rejects.toThrow(
        /invalid mailbox/i
      );
    });

    it("rejects mailbox IDs with non-hex characters", async () => {
      const badId = "g".repeat(64); // 'g' is not valid hex
      await expect(store.put(badId, "hello")).rejects.toThrow(
        /invalid mailbox/i
      );
    });

    it("rejects mailbox IDs that are too long", async () => {
      const longId = "a".repeat(65);
      await expect(store.put(longId, "hello")).rejects.toThrow(
        /invalid mailbox/i
      );
    });

    it("rejects when mailbox already has 1000 blobs", async () => {
      // Fill the mailbox to capacity
      for (let i = 0; i < 1000; i++) {
        await store.put(VALID_MAILBOX_ID, `blob-${i}`);
      }

      await expect(store.put(VALID_MAILBOX_ID, "overflow")).rejects.toThrow(
        /full/i
      );
    });

    it("allows exactly 1000 blobs in a mailbox", async () => {
      for (let i = 0; i < 999; i++) {
        await store.put(VALID_MAILBOX_ID, `blob-${i}`);
      }
      // The 1000th should succeed
      const result = await store.put(VALID_MAILBOX_ID, "blob-999");
      expect(result.id).toBeTruthy();
    });
  });

  // ─── get ────────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns all blobs stored in a mailbox", async () => {
      await store.put(VALID_MAILBOX_ID, "first");
      await store.put(VALID_MAILBOX_ID, "second");

      const blobs = await store.get(VALID_MAILBOX_ID);
      expect(blobs).toHaveLength(2);
      expect(blobs.map((b) => b.blob)).toEqual(
        expect.arrayContaining(["first", "second"])
      );
    });

    it("returns blobs with id and ts fields", async () => {
      await store.put(VALID_MAILBOX_ID, "test");
      const blobs = await store.get(VALID_MAILBOX_ID);

      expect(blobs[0]).toHaveProperty("id");
      expect(blobs[0]).toHaveProperty("blob", "test");
      expect(blobs[0]).toHaveProperty("ts");
      expect(typeof blobs[0].ts).toBe("number");
    });

    it("filters blobs by after timestamp", async () => {
      await store.put(VALID_MAILBOX_ID, "old");
      // Ensure the midpoint timestamp is strictly before "new" blob's ts
      await new Promise((r) => setTimeout(r, 2));
      const midpoint = Date.now();
      await new Promise((r) => setTimeout(r, 2));
      await store.put(VALID_MAILBOX_ID, "new");

      const blobs = await store.get(VALID_MAILBOX_ID, midpoint);
      expect(blobs).toHaveLength(1);
      expect(blobs[0].blob).toBe("new");
    });

    it("returns empty array for unknown mailbox", async () => {
      const blobs = await store.get(VALID_MAILBOX_ID);
      expect(blobs).toEqual([]);
    });

    it("returns empty array when after timestamp is in the future", async () => {
      await store.put(VALID_MAILBOX_ID, "something");
      const future = Date.now() + 999_999;
      const blobs = await store.get(VALID_MAILBOX_ID, future);
      expect(blobs).toEqual([]);
    });
  });

  // ─── del ────────────────────────────────────────────────────────────────────

  describe("del", () => {
    it("deletes a specific blob by id and returns true", async () => {
      const { id } = await store.put(VALID_MAILBOX_ID, "target");
      await store.put(VALID_MAILBOX_ID, "keep");

      const deleted = await store.del(VALID_MAILBOX_ID, id);
      expect(deleted).toBe(true);

      const remaining = await store.get(VALID_MAILBOX_ID);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].blob).toBe("keep");
    });

    it("returns false for a non-existent blob id", async () => {
      await store.put(VALID_MAILBOX_ID, "something");
      const deleted = await store.del(VALID_MAILBOX_ID, "nonexistent-id");
      expect(deleted).toBe(false);
    });

    it("returns false for an unknown mailbox", async () => {
      const deleted = await store.del(VALID_MAILBOX_ID, "some-id");
      expect(deleted).toBe(false);
    });
  });
});
