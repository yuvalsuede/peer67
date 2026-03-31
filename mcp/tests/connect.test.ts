import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../relay/src/index.js";
import { LocalStore } from "../src/store.js";
import { connectCreate, connectAccept, connectComplete } from "../src/tools/connect.js";

let relay: FastifyInstance;
let relayUrl: string;

beforeAll(async () => {
  relay = await buildApp({ redisUrl: "redis://mock" });
  await relay.listen({ port: 0, host: "127.0.0.1" });
  const addrs = relay.addresses();
  const addr = addrs[0];
  relayUrl = `http://${addr.address}:${addr.port}`;
});

afterAll(async () => {
  await relay.close();
});

function makeStore(name: string): { store: LocalStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `peer67-connect-test-${name}-`));
  const store = new LocalStore(dir);
  return { store, dir };
}

function writeConfig(dir: string, relayUrlOverride: string): void {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ default_relay: relayUrlOverride, poll_interval_seconds: 5 }),
    "utf8"
  );
}

describe("connect handshake", () => {
  let aliceDir: string;
  let bobDir: string;
  let aliceStore: LocalStore;
  let bobStore: LocalStore;

  beforeEach(async () => {
    const alice = makeStore("alice");
    const bob = makeStore("bob");
    aliceDir = alice.dir;
    bobDir = bob.dir;
    aliceStore = alice.store;
    bobStore = bob.store;

    // init both stores and write config pointing to test relay
    await aliceStore.init("alice");
    await bobStore.init("bob");
    writeConfig(aliceDir, relayUrl);
    writeConfig(bobDir, relayUrl);
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it("full connection handshake — both sides share symmetric key and complementary mailboxes", async () => {
    // Alice creates a connection code (passing relayUrl explicitly)
    const { code } = await connectCreate(aliceStore, "bob", relayUrl);
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(0);

    // Bob accepts with Alice's code
    const acceptResult = await connectAccept(bobStore, "alice", code);
    expect(acceptResult.connected).toBe(true);
    expect(acceptResult.name).toBe("alice");

    // Alice polls until complete (relay now has Bob's public key)
    const completedName = await connectComplete(aliceStore);
    expect(completedName).toBe("bob");

    // Both sides now have connection entries
    const aliceConn = await aliceStore.getConnection("bob");
    const bobConn = await bobStore.getConnection("alice");

    expect(aliceConn).toBeDefined();
    expect(bobConn).toBeDefined();

    // Alice's send mailbox must equal Bob's recv mailbox
    expect(aliceConn!.mailbox_send).toBe(bobConn!.mailbox_recv);

    // Alice's recv mailbox must equal Bob's send mailbox
    expect(aliceConn!.mailbox_recv).toBe(bobConn!.mailbox_send);

    // Both sides must have derived the same shared key
    expect(aliceConn!.shared_key).toBe(bobConn!.shared_key);

    // Relay URL should be stored on both connections
    expect(aliceConn!.relay_url).toBe(relayUrl);
    expect(bobConn!.relay_url).toBe(relayUrl);
  });

  it("connectComplete returns null when no pending connection exists", async () => {
    const result = await connectComplete(aliceStore);
    expect(result).toBeNull();
  });

  it("connectComplete returns null while acceptor has not yet responded", async () => {
    // Alice creates code but nobody accepts yet
    await connectCreate(aliceStore, "nobody", relayUrl);
    const result = await connectComplete(aliceStore);
    expect(result).toBeNull();
  });
});
