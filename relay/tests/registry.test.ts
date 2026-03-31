import { describe, it, expect, beforeEach } from "vitest";
import { RegistryStore } from "../src/registry.js";
import Redis from "ioredis-mock";

describe("RegistryStore", () => {
  let registry: RegistryStore;
  let redis: InstanceType<typeof Redis>;

  beforeEach(async () => {
    redis = new Redis();
    await redis.flushall();
    registry = new RegistryStore(redis as any);
  });

  describe("createMagicLink", () => {
    it("creates a token and stores registration data", async () => {
      const token = await registry.createMagicLink({
        email: "suede@example.com",
        handle: "Suede",
        pub: "AAAA",
        device_id: "dev1",
      });
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(32);
    });

    it("rate limits to 3 attempts per email per hour", async () => {
      const data = { email: "suede@example.com", handle: "Suede", pub: "AAAA", device_id: "dev1" };
      await registry.createMagicLink(data);
      await registry.createMagicLink(data);
      await registry.createMagicLink(data);
      await expect(registry.createMagicLink(data)).rejects.toThrow("rate limit");
    });
  });

  describe("verifyMagicLink", () => {
    it("verifies a valid token and creates directory entry", async () => {
      const data = { email: "suede@example.com", handle: "Suede", pub: "AAAA", device_id: "dev1" };
      const token = await registry.createMagicLink(data);
      const result = await registry.verifyMagicLink(token);
      expect(result).not.toBeNull();
      expect(result!.handle).toBe("Suede");
    });

    it("rejects invalid token", async () => {
      const result = await registry.verifyMagicLink("bogus");
      expect(result).toBeNull();
    });

    it("rejects already-used token", async () => {
      const data = { email: "suede@example.com", handle: "Suede", pub: "AAAA", device_id: "dev1" };
      const token = await registry.createMagicLink(data);
      await registry.verifyMagicLink(token);
      const result = await registry.verifyMagicLink(token);
      expect(result).toBeNull();
    });
  });

  describe("checkVerification", () => {
    it("returns true after verification", async () => {
      const data = { email: "suede@example.com", handle: "Suede", pub: "AAAA", device_id: "dev1" };
      const token = await registry.createMagicLink(data);
      await registry.verifyMagicLink(token);
      const emailHash = registry.hashEmail("suede@example.com");
      const verified = await registry.checkVerification(emailHash, "dev1");
      expect(verified).toBe(true);
    });

    it("returns false before verification", async () => {
      const emailHash = registry.hashEmail("nobody@example.com");
      const verified = await registry.checkVerification(emailHash, "dev1");
      expect(verified).toBe(false);
    });
  });

  describe("lookup", () => {
    it("finds a registered user by email hash", async () => {
      const data = { email: "suede@example.com", handle: "Suede", pub: "AAAA", device_id: "dev1" };
      const token = await registry.createMagicLink(data);
      await registry.verifyMagicLink(token);
      const emailHash = registry.hashEmail("suede@example.com");
      const result = await registry.lookup(emailHash);
      expect(result).not.toBeNull();
      expect(result!.handle).toBe("Suede");
      expect(result!.pub).toBe("AAAA");
    });

    it("returns null for unknown email hash", async () => {
      const result = await registry.lookup("0".repeat(64));
      expect(result).toBeNull();
    });
  });

  describe("directory", () => {
    it("lists all registered users", async () => {
      const d1 = { email: "a@x.com", handle: "Alice", pub: "AAA", device_id: "d1" };
      const d2 = { email: "b@x.com", handle: "Bob", pub: "BBB", device_id: "d2" };
      const t1 = await registry.createMagicLink(d1);
      const t2 = await registry.createMagicLink(d2);
      await registry.verifyMagicLink(t1);
      await registry.verifyMagicLink(t2);
      const users = await registry.directory();
      expect(users).toHaveLength(2);
      expect(users.map(u => u.handle).sort()).toEqual(["Alice", "Bob"]);
    });

    it("supports search by handle prefix", async () => {
      const d1 = { email: "a@x.com", handle: "Alice", pub: "AAA", device_id: "d1" };
      const d2 = { email: "b@x.com", handle: "Bob", pub: "BBB", device_id: "d2" };
      const t1 = await registry.createMagicLink(d1);
      const t2 = await registry.createMagicLink(d2);
      await registry.verifyMagicLink(t1);
      await registry.verifyMagicLink(t2);
      const results = await registry.directory("ali");
      expect(results).toHaveLength(1);
      expect(results[0].handle).toBe("Alice");
    });
  });

  describe("invites", () => {
    it("creates an invite for an unregistered email", async () => {
      const id = await registry.createInvite({
        target_email: "dana@gmail.com",
        from_handle: "Suede",
        from_pub: "AAAA",
        from_relay: "https://relay.peer67.com",
      });
      expect(id).toBeDefined();
    });

    it("retrieves pending invites by email hash", async () => {
      await registry.createInvite({
        target_email: "dana@gmail.com",
        from_handle: "Suede",
        from_pub: "AAAA",
        from_relay: "https://relay.peer67.com",
      });
      const emailHash = registry.hashEmail("dana@gmail.com");
      const invites = await registry.getInvites(emailHash);
      expect(invites).toHaveLength(1);
      expect(invites[0].from_handle).toBe("Suede");
    });

    it("deletes an invite by id", async () => {
      const id = await registry.createInvite({
        target_email: "dana@gmail.com",
        from_handle: "Suede",
        from_pub: "AAAA",
        from_relay: "https://relay.peer67.com",
      });
      const emailHash = registry.hashEmail("dana@gmail.com");
      await registry.deleteInvite(emailHash, id);
      const invites = await registry.getInvites(emailHash);
      expect(invites).toHaveLength(0);
    });
  });
});
