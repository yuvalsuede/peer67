import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../relay/src/index.js";
import { LocalStore } from "../src/store.js";
import { connectCreate, connectAccept, connectComplete } from "../src/tools/connect.js";
import { sendMessage } from "../src/tools/send.js";
import { checkInbox, acknowledgeMessages } from "../src/tools/inbox.js";

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
  const dir = mkdtempSync(join(tmpdir(), `peer67-send-test-${name}-`));
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

async function establishConnection(
  aliceStore: LocalStore,
  bobStore: LocalStore,
  testRelayUrl: string
): Promise<void> {
  const { code } = await connectCreate(aliceStore, "bob", testRelayUrl);
  await connectAccept(bobStore, "alice", code);
  await connectComplete(aliceStore);
}

describe("send / receive / decrypt", () => {
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

    await aliceStore.init("alice");
    await bobStore.init("bob");
    writeConfig(aliceDir, relayUrl);
    writeConfig(bobDir, relayUrl);

    await establishConnection(aliceStore, bobStore, relayUrl);
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it("Alice sends, Bob receives and decrypts", async () => {
    const { sent, expires_at } = await sendMessage(aliceStore, "bob", "Hello Bob!");
    expect(sent).toBe(true);
    expect(typeof expires_at).toBe("string");

    const messages = await checkInbox(bobStore, "alice");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Hello Bob!");
    expect(messages[0].from).toBe("alice");
  });

  it("Bob sends, Alice receives and decrypts", async () => {
    await sendMessage(bobStore, "alice", "Hello Alice!");

    const messages = await checkInbox(aliceStore, "bob");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Hello Alice!");
    expect(messages[0].from).toBe("bob");
  });

  it("multiple messages in sequence — both received in order", async () => {
    await sendMessage(aliceStore, "bob", "First message");
    await sendMessage(aliceStore, "bob", "Second message");

    const messages = await checkInbox(bobStore, "alice");
    expect(messages).toHaveLength(2);

    const bodies = messages.map((m) => m.body);
    expect(bodies).toContain("First message");
    expect(bodies).toContain("Second message");
  });

  it("acknowledging messages removes them from inbox", async () => {
    await sendMessage(aliceStore, "bob", "Ephemeral message");

    const before = await checkInbox(bobStore, "alice");
    expect(before).toHaveLength(1);

    await acknowledgeMessages(before);

    const after = await checkInbox(bobStore, "alice");
    expect(after).toHaveLength(0);
  });

  it("checkInbox returns empty when no messages", async () => {
    const messages = await checkInbox(bobStore, "alice");
    expect(messages).toHaveLength(0);
  });

  it("sendMessage throws when sending to unknown contact", async () => {
    await expect(
      sendMessage(aliceStore, "charlie", "Hey stranger!")
    ).rejects.toThrow('No connection found for "charlie"');
  });
});
