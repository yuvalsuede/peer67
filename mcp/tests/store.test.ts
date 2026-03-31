import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/store.js";
import type { ConnectionData, PendingConnection, StoreData } from "../src/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "peer67-store-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const sampleConn: ConnectionData = {
  display_name: "Alice",
  mailbox_send: "aabbcc",
  mailbox_recv: "ddeeff",
  shared_key: "112233",
  relay_url: "https://relay.example.com",
  created_at: "2024-01-01T00:00:00Z",
  last_seen: "2024-01-02T00:00:00Z",
};

const samplePending: PendingConnection = {
  name: "bob",
  connection_code: "XYZ123",
  private_key: "aabbccdd",
  public_key: "eeff0011",
  created_at: "2024-01-01T00:00:00Z",
};

describe("LocalStore", () => {
  describe("init", () => {
    it("creates store.json and config.json", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      const { existsSync } = await import("node:fs");
      expect(existsSync(join(tmpDir, "store.json"))).toBe(true);
      expect(existsSync(join(tmpDir, "config.json"))).toBe(true);
    });

    it("preserves existing data on re-init", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.addConnection("bob", sampleConn);

      // Re-init should NOT overwrite
      const store2 = new LocalStore(tmpDir);
      await store2.init("alice");

      const data = await store2.load();
      expect(data.connections["bob"]).toBeDefined();
      expect(data.connections["bob"].display_name).toBe("Alice");
    });
  });

  describe("addConnection + load", () => {
    it("round-trips connection data", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.addConnection("bob", sampleConn);

      const data: StoreData = await store.load();
      expect(data.connections["bob"]).toEqual(sampleConn);
    });
  });

  describe("removeConnection", () => {
    it("removes connection correctly", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.addConnection("bob", sampleConn);
      await store.removeConnection("bob");

      const data = await store.load();
      expect(data.connections["bob"]).toBeUndefined();
    });

    it("does not throw when removing non-existent connection", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await expect(store.removeConnection("nobody")).resolves.not.toThrow();
    });
  });

  describe("listConnections", () => {
    it("returns all connections", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.addConnection("bob", sampleConn);
      await store.addConnection("carol", {
        ...sampleConn,
        display_name: "Carol",
        mailbox_send: "aabbccee",
        mailbox_recv: "ddeeffaa",
        shared_key: "112244",
      });

      const list = await store.listConnections();
      expect(list).toHaveLength(2);
      const names = list.map((c) => c.name);
      expect(names).toContain("bob");
      expect(names).toContain("carol");
      expect(list.find((c) => c.name === "bob")?.display_name).toBe("Alice");
    });

    it("returns empty array when no connections", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      const list = await store.listConnections();
      expect(list).toEqual([]);
    });
  });

  describe("getConnection", () => {
    it("returns the connection by name", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.addConnection("bob", sampleConn);

      const conn = await store.getConnection("bob");
      expect(conn).toEqual(sampleConn);
    });

    it("returns undefined for unknown connection", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      const conn = await store.getConnection("nobody");
      expect(conn).toBeUndefined();
    });
  });

  describe("setPending + load", () => {
    it("stores pending connection", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.setPending(samplePending);

      const data = await store.load();
      expect(data.pending).toEqual(samplePending);
    });
  });

  describe("clearPending", () => {
    it("removes pending connection", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      await store.setPending(samplePending);
      await store.clearPending();

      const data = await store.load();
      expect(data.pending).toBeUndefined();
    });
  });

  describe("getConfig", () => {
    it("returns default config values", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");
      const config = await store.getConfig();
      expect(config).toHaveProperty("default_relay");
      expect(config).toHaveProperty("poll_interval_seconds");
      expect(typeof config.default_relay).toBe("string");
      expect(typeof config.poll_interval_seconds).toBe("number");
    });
  });

  describe("identity keypair", () => {
    it("generates keypair and device_id on init", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      const data = await store.load();
      expect(data.identity.identity_key_private).toBeDefined();
      expect(data.identity.identity_key_public).toBeDefined();
      expect(data.identity.device_id).toBeDefined();
      expect(typeof data.identity.identity_key_private).toBe("string");
      expect(typeof data.identity.identity_key_public).toBe("string");
      expect(typeof data.identity.device_id).toBe("string");
      // hex strings should be non-empty
      expect(data.identity.identity_key_private!.length).toBeGreaterThan(0);
      expect(data.identity.identity_key_public!.length).toBeGreaterThan(0);
      expect(data.identity.device_id!.length).toBeGreaterThan(0);
    });

    it("updateIdentity sets email", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await store.updateIdentity({ email: "alice@example.com" });

      const data = await store.load();
      expect(data.identity.email).toBe("alice@example.com");
      // existing fields not wiped
      expect(data.identity.name).toBe("alice");
      expect(data.identity.identity_key_public).toBeDefined();
    });

    it("updateIdentity merges without overwriting unrelated fields", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await store.updateIdentity({ email: "alice@example.com" });
      await store.updateIdentity({ registered_at: "2024-01-01T00:00:00Z" });

      const data = await store.load();
      expect(data.identity.email).toBe("alice@example.com");
      expect(data.identity.registered_at).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("pending invites", () => {
    const sampleInvite = {
      email: "bob@example.com",
      email_hash: "abc123",
      created_at: "2024-01-01T00:00:00Z",
    };

    it("addPendingInvite adds to list", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await store.addPendingInvite(sampleInvite);

      const data = await store.load();
      expect(data.pending_invites).toHaveLength(1);
      expect(data.pending_invites![0]).toEqual(sampleInvite);
    });

    it("addPendingInvite appends to existing list", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await store.addPendingInvite(sampleInvite);
      await store.addPendingInvite({
        email: "carol@example.com",
        email_hash: "def456",
        created_at: "2024-01-02T00:00:00Z",
      });

      const data = await store.load();
      expect(data.pending_invites).toHaveLength(2);
    });

    it("removePendingInvite removes by email_hash", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await store.addPendingInvite(sampleInvite);
      await store.addPendingInvite({
        email: "carol@example.com",
        email_hash: "def456",
        created_at: "2024-01-02T00:00:00Z",
      });

      await store.removePendingInvite("abc123");

      const data = await store.load();
      expect(data.pending_invites).toHaveLength(1);
      expect(data.pending_invites![0].email_hash).toBe("def456");
    });

    it("removePendingInvite does not throw for non-existent hash", async () => {
      const store = new LocalStore(tmpDir);
      await store.init("alice");

      await expect(store.removePendingInvite("nonexistent")).resolves.not.toThrow();
    });
  });
});
