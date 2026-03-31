import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../relay/src/index.js";
import { LocalStore } from "../src/store.js";
import { inviteByEmail } from "../src/tools/invite.js";
import { checkConnectInbox, connectComplete } from "../src/tools/connect.js";
import { sendMessage } from "../src/tools/send.js";
import { checkInbox } from "../src/tools/inbox.js";
import { RelayClient } from "../src/relay-client.js";

let relay: FastifyInstance;
let relayUrl: string;

beforeAll(async () => {
  relay = await buildApp({ redisUrl: "redis://mock" });
  await relay.listen({ port: 0, host: "127.0.0.1" });
  const addrs = relay.addresses();
  const addr = addrs[0];
  relayUrl = `http://${addr.address}:${addr.port}`;
  process.env.PEER67_RELAY = relayUrl;
});

afterAll(async () => {
  delete process.env.PEER67_RELAY;
  await relay.close();
});

function makeStore(name: string): { store: LocalStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `peer67-registry-test-${name}-`));
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

function computeEmailHash(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/**
 * Register a user via the relay (inject directly since no real email).
 * Returns the email_hash after verifying the magic link.
 */
async function registerUser(
  store: LocalStore,
  email: string
): Promise<{ email_hash: string }> {
  const data = await store.load();
  const { identity } = data;

  const pub = Buffer.from(identity.identity_key_public!, "hex").toString("base64");
  const device_id = identity.device_id!;

  // POST /r/register — relay returns token in test mode (no RESEND_API_KEY)
  const regRes = await relay.inject({
    method: "POST",
    url: "/r/register",
    payload: { email, handle: identity.name, pub, device_id },
  });

  const body = JSON.parse(regRes.body) as { token?: string; email_hash?: string; error?: string };
  if (!body.token) {
    throw new Error(`Registration failed: ${body.error ?? regRes.body}`);
  }

  const { token, email_hash } = body as { token: string; email_hash: string };

  // GET /r/verify?token=... — click the magic link
  await relay.inject({
    method: "GET",
    url: `/r/verify?token=${token}`,
  });

  // Update local store with registered email
  await store.updateIdentity({ email, registered_at: new Date().toISOString() });

  return { email_hash };
}

describe("discovery flow: register → invite → auto-connect → message", () => {
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
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it("full discovery flow: register, invite by email, auto-connect, send and receive messages", async () => {
    // a. Alice registers
    await registerUser(aliceStore, "alice@test.com");

    // b. Bob registers
    await registerUser(bobStore, "bob@test.com");

    // c. Alice invites Bob by email — Bob is registered so status should be "connected"
    const inviteResult = await inviteByEmail(aliceStore, "bob@test.com");
    expect(inviteResult.status).toBe("connected");

    // d. Bob checks connect inbox — should find Alice's request
    const fromHandle = await checkConnectInbox(bobStore);
    expect(fromHandle).toBe("alice");

    // e. Alice calls connectComplete — handshake finalizes
    // Note: the connection name is keyed by email (the value passed to connectAutoInitiate)
    const completedName = await connectComplete(aliceStore);
    expect(completedName).toBe("bob@test.com");

    // f. Alice sends message to Bob (connection keyed by email), Bob receives and decrypts
    // Alice's connection is stored under "bob@test.com" (the email passed to connectAutoInitiate)
    // Bob's connection is stored under "alice" (from_handle in the connect_request payload)
    const { sent } = await sendMessage(aliceStore, "bob@test.com", "Hello Bob via discovery!");
    expect(sent).toBe(true);

    const bobMessages = await checkInbox(bobStore, "alice");
    expect(bobMessages).toHaveLength(1);
    expect(bobMessages[0].body).toBe("Hello Bob via discovery!");
    expect(bobMessages[0].from).toBe("alice");

    // g. Verify Bob → Alice direction also works
    await sendMessage(bobStore, "alice", "Hello Alice!");
    const aliceMessages = await checkInbox(aliceStore, "bob@test.com");
    expect(aliceMessages).toHaveLength(1);
    expect(aliceMessages[0].body).toBe("Hello Alice!");
    expect(aliceMessages[0].from).toBe("bob@test.com");
  });
});

describe("invite flow: invite unregistered user", () => {
  // Use distinct email domain to avoid rate-limit collisions with other describe blocks
  let aliceDir: string;
  let aliceStore: LocalStore;

  beforeEach(async () => {
    const alice = makeStore("alice");
    aliceDir = alice.dir;
    aliceStore = alice.store;

    await aliceStore.init("alice");
    writeConfig(aliceDir, relayUrl);
    await registerUser(aliceStore, "alice@invite-test.com");
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
  });

  it("inviting an unregistered user returns status 'invited'", async () => {
    const result = await inviteByEmail(aliceStore, "dana@test.com");
    expect(result.status).toBe("invited");
  });

  it("invite exists on relay after inviting unregistered user", async () => {
    await inviteByEmail(aliceStore, "dana2@test.com");

    const danaEmailHash = computeEmailHash("dana2@test.com");

    const relayClient = new RelayClient(relayUrl);
    const invites = await relayClient.getInvites(danaEmailHash);

    expect(invites.length).toBeGreaterThan(0);
    expect(invites[0].from_handle).toBe("alice");
  });
});

describe("directory listing", () => {
  // Use distinct email domain to avoid rate-limit collisions with other describe blocks
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

    await registerUser(aliceStore, "alice@dir-test.com");
    await registerUser(bobStore, "bob@dir-test.com");
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it("directory() lists all registered users", async () => {
    const relayClient = new RelayClient(relayUrl);
    const users = await relayClient.directory();

    const handles = users.map((u) => u.handle);
    expect(handles).toContain("alice");
    expect(handles).toContain("bob");
  });

  it("directory() with search prefix filters results", async () => {
    const relayClient = new RelayClient(relayUrl);
    const users = await relayClient.directory("ali");

    const handles = users.map((u) => u.handle);
    expect(handles).toContain("alice");
    expect(handles).not.toContain("bob");
  });
});
