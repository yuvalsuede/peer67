# Discovery Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email-based registration and discovery so users can find each other by email instead of exchanging connection codes manually. Messages remain anonymous — discovery and messaging are separate planes.

**Architecture:** The relay gains a `/r/*` registry (registration, lookup, invites) alongside the existing `/d/*` dead-drop. Users register with email via magic link. Once registered, "invite dana@gmail.com" auto-connects if Dana is registered, or sends an invite email if not. The key exchange happens automatically in the background — no manual code copy-paste. The messaging plane is completely unchanged.

**Tech Stack:** Existing stack + Resend (email), new Redis key prefixes for registry data.

---

## File Structure

### Relay — new files
```
relay/src/registry.ts         # RegistryStore: register, verify, lookup, invites (Redis-backed)
relay/src/email.ts            # Email sending via Resend (magic links, invites)
relay/src/registry-routes.ts  # /r/* HTTP routes
relay/tests/registry.test.ts  # Registry store unit tests
relay/tests/registry-routes.test.ts  # Registry HTTP integration tests
```

### Relay — modified files
```
relay/src/index.ts            # Import and register registry routes
relay/package.json            # Add resend dependency
```

### MCP — new files
```
mcp/src/tools/register.ts     # peer67_register tool: email registration + poll verification
mcp/src/tools/invite.ts       # peer67_invite tool: invite by email, auto-connect
mcp/tests/registry.test.ts    # Registration + invite integration tests
```

### MCP — modified files
```
mcp/src/store.ts              # Add email, identity keypair, pending_invites to StoreData
mcp/src/relay-client.ts       # Add registry methods (register, verify, lookup, invites)
mcp/src/index.ts              # Add new tools, update polling, update setup CLI
mcp/src/setup.ts              # Add email registration to setup flow
mcp/src/tools/connect.ts      # Add checkConnectInbox, auto-accept from discovery
```

---

## Task 1: Relay — Registry Store

**Files:**
- Create: `relay/src/registry.ts`
- Create: `relay/tests/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `relay/tests/registry.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd relay && npx vitest run tests/registry.test.ts
```

Expected: FAIL — `RegistryStore` not found.

- [ ] **Step 3: Implement RegistryStore**

Create `relay/src/registry.ts`:

```typescript
import type { Redis } from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";

const MAGIC_LINK_TTL = 600;        // 10 minutes
const VERIFICATION_FLAG_TTL = 300;  // 5 minutes
const DIRECTORY_TTL = 2592000;      // 30 days
const INVITE_TTL = 604800;          // 7 days
const RATE_LIMIT_TTL = 3600;        // 1 hour
const MAX_REGISTRATION_ATTEMPTS = 3;

interface RegistrationData {
  email: string;
  handle: string;
  pub: string;      // base64 identity public key
  device_id: string;
}

interface DirectoryEntry {
  handle: string;
  pub: string;
  device_id: string;
  registered_at: string;
}

interface InviteData {
  target_email: string;
  from_handle: string;
  from_pub: string;
  from_relay: string;
}

interface InviteEntry {
  id: string;
  from_handle: string;
  from_pub: string;
  from_relay: string;
  created_at: string;
}

export class RegistryStore {
  constructor(private readonly redis: Redis) {}

  hashEmail(email: string): string {
    return createHash("sha256")
      .update(email.toLowerCase().trim())
      .digest("hex");
  }

  async createMagicLink(data: RegistrationData): Promise<string> {
    const emailHash = this.hashEmail(data.email);

    // Rate limit
    const rlKey = `rl:reg:${emailHash}`;
    const attempts = await this.redis.incr(rlKey);
    if (attempts === 1) {
      await this.redis.expire(rlKey, RATE_LIMIT_TTL);
    }
    if (attempts > MAX_REGISTRATION_ATTEMPTS) {
      throw new Error("Registration rate limit exceeded");
    }

    const token = randomBytes(64).toString("hex");
    const mlKey = `ml:${token}`;

    await this.redis.set(
      mlKey,
      JSON.stringify({
        email: data.email.toLowerCase().trim(),
        email_hash: emailHash,
        handle: data.handle,
        pub: data.pub,
        device_id: data.device_id,
      }),
      "EX",
      MAGIC_LINK_TTL
    );

    return token;
  }

  async verifyMagicLink(
    token: string
  ): Promise<{ handle: string; email_hash: string } | null> {
    const mlKey = `ml:${token}`;
    const raw = await this.redis.get(mlKey);
    if (!raw) return null;

    // Delete token (one-time use)
    await this.redis.del(mlKey);

    const data = JSON.parse(raw) as {
      email: string;
      email_hash: string;
      handle: string;
      pub: string;
      device_id: string;
    };

    // Store directory entry
    const dirKey = `dir:${data.email_hash}`;
    const entry: DirectoryEntry = {
      handle: data.handle,
      pub: data.pub,
      device_id: data.device_id,
      registered_at: new Date().toISOString(),
    };
    await this.redis.set(dirKey, JSON.stringify(entry), "EX", DIRECTORY_TTL);

    // Add to directory index (for listing)
    await this.redis.sadd("dir:index", data.email_hash);

    // Set verification flag (short TTL, for polling)
    const vfKey = `vf:${data.email_hash}:${data.device_id}`;
    await this.redis.set(vfKey, "ok", "EX", VERIFICATION_FLAG_TTL);

    return { handle: data.handle, email_hash: data.email_hash };
  }

  async checkVerification(
    emailHash: string,
    deviceId: string
  ): Promise<boolean> {
    const vfKey = `vf:${emailHash}:${deviceId}`;
    const val = await this.redis.get(vfKey);
    return val === "ok";
  }

  async lookup(
    emailHash: string
  ): Promise<{ handle: string; pub: string } | null> {
    const dirKey = `dir:${emailHash}`;
    const raw = await this.redis.get(dirKey);
    if (!raw) return null;

    const entry = JSON.parse(raw) as DirectoryEntry;
    return { handle: entry.handle, pub: entry.pub };
  }

  async directory(search?: string): Promise<Array<{ handle: string; pub: string }>> {
    const hashes = await this.redis.smembers("dir:index");
    const results: Array<{ handle: string; pub: string }> = [];

    for (const hash of hashes) {
      const raw = await this.redis.get(`dir:${hash}`);
      if (!raw) continue;
      const entry = JSON.parse(raw) as DirectoryEntry;
      if (search && !entry.handle.toLowerCase().startsWith(search.toLowerCase())) {
        continue;
      }
      results.push({ handle: entry.handle, pub: entry.pub });
    }

    return results.sort((a, b) => a.handle.localeCompare(b.handle));
  }

  async createInvite(data: InviteData): Promise<string> {
    const emailHash = this.hashEmail(data.target_email);
    const id = nanoid();
    const invKey = `inv:${emailHash}`;

    const entry: InviteEntry = {
      id,
      from_handle: data.from_handle,
      from_pub: data.from_pub,
      from_relay: data.from_relay,
      created_at: new Date().toISOString(),
    };

    await this.redis.rpush(invKey, JSON.stringify(entry));
    await this.redis.expire(invKey, INVITE_TTL);

    return id;
  }

  async getInvites(emailHash: string): Promise<InviteEntry[]> {
    const invKey = `inv:${emailHash}`;
    const raw = await this.redis.lrange(invKey, 0, -1);
    return raw.map((r) => JSON.parse(r) as InviteEntry);
  }

  async deleteInvite(emailHash: string, inviteId: string): Promise<boolean> {
    const invKey = `inv:${emailHash}`;
    const raw = await this.redis.lrange(invKey, 0, -1);

    for (const entry of raw) {
      const parsed = JSON.parse(entry) as InviteEntry;
      if (parsed.id === inviteId) {
        const removed = await this.redis.lrem(invKey, 1, entry);
        return removed > 0;
      }
    }
    return false;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd relay && npx vitest run tests/registry.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add relay/src/registry.ts relay/tests/registry.test.ts
git commit -m "feat(relay): registry store — registration, lookup, directory, invites"
```

---

## Task 2: Relay — Email Service

**Files:**
- Create: `relay/src/email.ts`
- Modify: `relay/package.json` (add resend)

- [ ] **Step 1: Install resend**

```bash
cd relay && npm install resend
```

- [ ] **Step 2: Implement email service**

Create `relay/src/email.ts`:

```typescript
import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.FROM_EMAIL || "noreply@peer67.com";

export async function sendMagicLink(
  to: string,
  verifyUrl: string
): Promise<void> {
  if (!resend) {
    console.log(`[email-disabled] Magic link for ${to}: ${verifyUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Verify your Peer67 identity",
    text: [
      "Click the link below to verify your Peer67 identity:",
      "",
      verifyUrl,
      "",
      "This link expires in 10 minutes.",
      "",
      "If you didn't request this, ignore this email.",
    ].join("\n"),
  });
}

export async function sendInviteEmail(
  to: string,
  fromHandle: string
): Promise<void> {
  if (!resend) {
    console.log(`[email-disabled] Invite to ${to} from ${fromHandle}`);
    return;
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: `${fromHandle} wants to message you on Peer67`,
    text: [
      `${fromHandle} invited you to Peer67 — encrypted ephemeral messaging.`,
      "",
      "To get started:",
      "  npm install -g @peer67/mcp",
      "  peer67 setup",
      "",
      "Messages are end-to-end encrypted and auto-delete after 24 hours.",
      "",
      "https://peer67.com",
    ].join("\n"),
  });
}

export function isEmailConfigured(): boolean {
  return resend !== null;
}
```

- [ ] **Step 3: Commit**

```bash
git add relay/src/email.ts relay/package.json relay/package-lock.json
git commit -m "feat(relay): email service — magic links and invite emails via Resend"
```

---

## Task 3: Relay — Registry HTTP Routes

**Files:**
- Create: `relay/src/registry-routes.ts`
- Create: `relay/tests/registry-routes.test.ts`
- Modify: `relay/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `relay/tests/registry-routes.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/index.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ redisUrl: "redis://mock" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("POST /r/register", () => {
  it("accepts registration and returns success", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "test@example.com",
        handle: "TestUser",
        pub: "dGVzdA==",
        device_id: "dev123",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().token).toBeDefined(); // returned in test mode (no email)
  });

  it("rejects missing email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { handle: "Test", pub: "x", device_id: "d" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /r/verify", () => {
  it("verifies a valid token", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "verify@example.com",
        handle: "VerifyUser",
        pub: "dGVzdA==",
        device_id: "dev1",
      },
    });
    const { token } = regRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/r/verify?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Verified");
  });

  it("rejects invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/verify?token=bogus",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /r/check-verification", () => {
  it("returns true after verification", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "check@example.com",
        handle: "CheckUser",
        pub: "dGVzdA==",
        device_id: "devcheck",
      },
    });
    const { token } = regRes.json();
    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({
      method: "GET",
      url: `/r/check-verification?email_hash=${regRes.json().email_hash}&device_id=devcheck`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
  });
});

describe("GET /r/lookup", () => {
  it("finds a registered user", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "lookup@example.com",
        handle: "LookupUser",
        pub: "bG9va3Vw",
        device_id: "devlookup",
      },
    });
    const { token, email_hash } = regRes.json();
    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({
      method: "GET",
      url: `/r/lookup?email_hash=${email_hash}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(true);
    expect(res.json().handle).toBe("LookupUser");
  });

  it("returns not found for unknown hash", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/r/lookup?email_hash=${"0".repeat(64)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().found).toBe(false);
  });
});

describe("GET /r/directory", () => {
  it("lists registered users", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/directory",
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().users)).toBe(true);
  });

  it("supports search query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/directory?q=Lookup",
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /r/invite", () => {
  it("creates an invite", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: "invitee@example.com",
        from_handle: "Suede",
        from_pub: "c3VlZGU=",
        from_relay: "https://relay.peer67.com",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().invite_id).toBeDefined();
  });
});

describe("GET /r/invites", () => {
  it("retrieves invites for an email hash", async () => {
    const { createHash } = await import("node:crypto");
    const emailHash = createHash("sha256").update("invitee@example.com").digest("hex");

    const res = await app.inject({
      method: "GET",
      url: `/r/invites?email_hash=${emailHash}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invites.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd relay && npx vitest run tests/registry-routes.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement registry routes**

Create `relay/src/registry-routes.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { RegistryStore } from "./registry.js";
import { sendMagicLink, sendInviteEmail, isEmailConfigured } from "./email.js";

export async function registerRegistryRoutes(
  app: FastifyInstance,
  registry: RegistryStore,
  relayUrl: string
): Promise<void> {

  // POST /r/register — start registration, send magic link
  app.post<{
    Body: { email: string; handle: string; pub: string; device_id: string };
  }>("/r/register", async (request, reply) => {
    const { email, handle, pub, device_id } = request.body ?? {};

    if (!email || !handle || !pub || !device_id) {
      return reply.status(400).send({ ok: false, error: "Missing required fields: email, handle, pub, device_id" });
    }

    try {
      const token = await registry.createMagicLink({ email, handle, pub, device_id });
      const verifyUrl = `${relayUrl}/r/verify?token=${token}`;

      await sendMagicLink(email, verifyUrl);

      const emailHash = registry.hashEmail(email);

      // In test/dev mode (no email configured), return the token directly
      if (!isEmailConfigured()) {
        return { ok: true, message: "Verification link generated", token, email_hash: emailHash };
      }

      return { ok: true, message: "Check your email for the verification link", email_hash: emailHash };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(429).send({ ok: false, error: message });
    }
  });

  // GET /r/verify — complete registration via magic link
  app.get<{
    Querystring: { token?: string };
  }>("/r/verify", async (request, reply) => {
    const { token } = request.query;
    if (!token) {
      return reply.status(400).send({ ok: false, error: "Token required" });
    }

    const result = await registry.verifyMagicLink(token);
    if (!result) {
      return reply.status(400).type("text/html").send(
        "<html><body><h2>Invalid or expired link</h2><p>Request a new verification link.</p></body></html>"
      );
    }

    return reply.type("text/html").send(
      `<html><body><h2>Verified!</h2><p>You're registered as "${result.handle}" on Peer67. You can close this tab and return to Claude.</p></body></html>`
    );
  });

  // GET /r/check-verification — poll for verification status
  app.get<{
    Querystring: { email_hash?: string; device_id?: string };
  }>("/r/check-verification", async (request, reply) => {
    const { email_hash, device_id } = request.query;
    if (!email_hash || !device_id) {
      return reply.status(400).send({ error: "email_hash and device_id required" });
    }

    const verified = await registry.checkVerification(email_hash, device_id);
    return { verified };
  });

  // GET /r/lookup — look up user by email hash
  app.get<{
    Querystring: { email_hash?: string };
  }>("/r/lookup", async (request, reply) => {
    const { email_hash } = request.query;
    if (!email_hash) {
      return reply.status(400).send({ error: "email_hash required" });
    }

    const result = await registry.lookup(email_hash);
    if (!result) {
      return { found: false };
    }

    return { found: true, handle: result.handle, pub: result.pub };
  });

  // GET /r/directory — list registered users
  app.get<{
    Querystring: { q?: string };
  }>("/r/directory", async (request) => {
    const users = await registry.directory(request.query.q);
    return { users };
  });

  // POST /r/invite — invite an unregistered user
  app.post<{
    Body: { target_email: string; from_handle: string; from_pub: string; from_relay: string };
  }>("/r/invite", async (request, reply) => {
    const { target_email, from_handle, from_pub, from_relay } = request.body ?? {};

    if (!target_email || !from_handle || !from_pub || !from_relay) {
      return reply.status(400).send({ ok: false, error: "Missing required fields" });
    }

    // Check if target is already registered
    const emailHash = registry.hashEmail(target_email);
    const existing = await registry.lookup(emailHash);
    if (existing) {
      return { ok: false, error: "already_registered", handle: existing.handle, pub: existing.pub };
    }

    const inviteId = await registry.createInvite({
      target_email,
      from_handle,
      from_pub,
      from_relay,
    });

    await sendInviteEmail(target_email, from_handle);

    return { ok: true, invite_id: inviteId };
  });

  // GET /r/invites — check pending invites for an email
  app.get<{
    Querystring: { email_hash?: string };
  }>("/r/invites", async (request, reply) => {
    const { email_hash } = request.query;
    if (!email_hash) {
      return reply.status(400).send({ error: "email_hash required" });
    }

    const invites = await registry.getInvites(email_hash);
    return { invites };
  });

  // DELETE /r/invites/:id — acknowledge an invite
  app.delete<{
    Params: { id: string };
    Querystring: { email_hash?: string };
  }>("/r/invites/:id", async (request, reply) => {
    const { email_hash } = request.query;
    if (!email_hash) {
      return reply.status(400).send({ error: "email_hash required" });
    }

    const deleted = await registry.deleteInvite(email_hash, request.params.id);
    return { ok: deleted };
  });
}
```

- [ ] **Step 4: Register routes in relay/src/index.ts**

Add to `relay/src/index.ts` — after the BlobStore is created and before the `/d/` routes, add:

```typescript
import { RegistryStore } from "./registry.js";
import { registerRegistryRoutes } from "./registry-routes.js";

// Inside buildApp(), after store is created:
const registryStore = new RegistryStore(redis);
const relayUrl = process.env.RELAY_URL || "https://relay-production-a9d5.up.railway.app";
await registerRegistryRoutes(app, registryStore, relayUrl);
```

The registry reuses the same Redis instance as the blob store but with different key prefixes (`dir:`, `ml:`, `inv:`, `vf:` vs `mb:`).

- [ ] **Step 5: Run all tests**

```bash
cd relay && npx vitest run
```

Expected: All existing tests + new registry tests PASS.

- [ ] **Step 6: Commit**

```bash
git add relay/src/registry-routes.ts relay/tests/registry-routes.test.ts relay/src/index.ts
git commit -m "feat(relay): registry HTTP routes — register, verify, lookup, directory, invites"
```

---

## Task 4: MCP — Update Local Store for Identity

**Files:**
- Modify: `mcp/src/store.ts`
- Modify: `mcp/tests/store.test.ts`

- [ ] **Step 1: Update StoreData interface**

Add `email`, `identity_key_private`, `identity_key_public`, `device_id`, and `pending_invites` to the store.

In `mcp/src/store.ts`, update the `StoreData` interface:

```typescript
export interface StoreData {
  version: number;
  identity: {
    name: string;
    email?: string;
    identity_key_private?: string;  // hex, long-lived X25519 key
    identity_key_public?: string;   // hex
    device_id?: string;             // hex
    registered_at?: string;
    created_at: string;
  };
  connections: Record<string, ConnectionData>;
  pending?: PendingConnection;
  pending_invites?: Array<{
    email: string;
    email_hash: string;
    created_at: string;
  }>;
}
```

Also add `email?: string` to `ConnectionData` so we know the email of connected contacts.

Update `init()` to generate an identity keypair and device_id:

```typescript
async init(name: string): Promise<void> {
  // ... existing dir/config creation ...

  if (!existsSync(this.storePath)) {
    // Generate identity keypair
    const { generateKeypair } = await import("./crypto.js");
    const kp = generateKeypair();
    const deviceId = createHash("sha256")
      .update(`${hostname()}:${userInfo().username}`)
      .digest("hex");

    const initial: StoreData = {
      version: STORE_VERSION,
      identity: {
        name,
        identity_key_private: Buffer.from(kp.privateKey).toString("hex"),
        identity_key_public: Buffer.from(kp.publicKey).toString("hex"),
        device_id: deviceId,
        created_at: new Date().toISOString(),
      },
      connections: {},
    };
    this.writeStore(initial);
  }
}
```

Add methods `updateIdentity` and `addPendingInvite` / `removePendingInvite`.

- [ ] **Step 2: Add tests for new store features**

Add to `mcp/tests/store.test.ts`:

```typescript
describe("identity", () => {
  it("generates identity keypair on init", async () => {
    await store.init("TestUser");
    const data = await store.load();
    expect(data.identity.identity_key_private).toBeDefined();
    expect(data.identity.identity_key_public).toBeDefined();
    expect(data.identity.device_id).toBeDefined();
  });

  it("updates email after registration", async () => {
    await store.init("TestUser");
    await store.updateIdentity({ email: "test@example.com", registered_at: new Date().toISOString() });
    const data = await store.load();
    expect(data.identity.email).toBe("test@example.com");
  });
});

describe("pending invites", () => {
  it("adds and lists pending invites", async () => {
    await store.init("TestUser");
    await store.addPendingInvite({ email: "dana@gmail.com", email_hash: "abc", created_at: new Date().toISOString() });
    const data = await store.load();
    expect(data.pending_invites).toHaveLength(1);
  });

  it("removes a pending invite", async () => {
    await store.init("TestUser");
    await store.addPendingInvite({ email: "dana@gmail.com", email_hash: "abc", created_at: new Date().toISOString() });
    await store.removePendingInvite("abc");
    const data = await store.load();
    expect(data.pending_invites).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Implement new methods**

```typescript
async updateIdentity(updates: Partial<StoreData["identity"]>): Promise<void> {
  const data = await this.load();
  const updated: StoreData = {
    ...data,
    identity: { ...data.identity, ...updates },
  };
  this.writeStore(updated);
}

async addPendingInvite(invite: { email: string; email_hash: string; created_at: string }): Promise<void> {
  const data = await this.load();
  const invites = data.pending_invites ?? [];
  const updated: StoreData = {
    ...data,
    pending_invites: [...invites, invite],
  };
  this.writeStore(updated);
}

async removePendingInvite(emailHash: string): Promise<void> {
  const data = await this.load();
  const updated: StoreData = {
    ...data,
    pending_invites: (data.pending_invites ?? []).filter(i => i.email_hash !== emailHash),
  };
  this.writeStore(updated);
}
```

- [ ] **Step 4: Run tests**

```bash
cd mcp && npx vitest run tests/store.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add mcp/src/store.ts mcp/tests/store.test.ts
git commit -m "feat(mcp): store v2 — identity keypair, email, pending invites"
```

---

## Task 5: MCP — Relay Client Registry Methods

**Files:**
- Modify: `mcp/src/relay-client.ts`

- [ ] **Step 1: Add registry methods to RelayClient**

```typescript
// Add to RelayClient class:

async register(data: {
  email: string;
  handle: string;
  pub: string;
  device_id: string;
}): Promise<{ ok: boolean; token?: string; email_hash?: string; message?: string; error?: string }> {
  const res = await fetch(`${this.baseUrl}/r/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json() as any;
}

async checkVerification(emailHash: string, deviceId: string): Promise<boolean> {
  const res = await fetch(
    `${this.baseUrl}/r/check-verification?email_hash=${emailHash}&device_id=${deviceId}`
  );
  if (!res.ok) return false;
  const body = await res.json() as { verified: boolean };
  return body.verified;
}

async lookup(emailHash: string): Promise<{ found: boolean; handle?: string; pub?: string } | null> {
  const res = await fetch(`${this.baseUrl}/r/lookup?email_hash=${emailHash}`);
  if (!res.ok) return null;
  return res.json() as any;
}

async directory(search?: string): Promise<Array<{ handle: string; pub: string }>> {
  const url = search
    ? `${this.baseUrl}/r/directory?q=${encodeURIComponent(search)}`
    : `${this.baseUrl}/r/directory`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const body = await res.json() as { users: Array<{ handle: string; pub: string }> };
  return body.users;
}

async invite(data: {
  target_email: string;
  from_handle: string;
  from_pub: string;
  from_relay: string;
}): Promise<{ ok: boolean; invite_id?: string; error?: string; handle?: string; pub?: string }> {
  const res = await fetch(`${this.baseUrl}/r/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.json() as any;
}

async getInvites(emailHash: string): Promise<Array<{
  id: string;
  from_handle: string;
  from_pub: string;
  from_relay: string;
  created_at: string;
}>> {
  const res = await fetch(`${this.baseUrl}/r/invites?email_hash=${emailHash}`);
  if (!res.ok) return [];
  const body = await res.json() as { invites: any[] };
  return body.invites;
}

async deleteInvite(emailHash: string, inviteId: string): Promise<void> {
  await fetch(`${this.baseUrl}/r/invites/${inviteId}?email_hash=${emailHash}`, {
    method: "DELETE",
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add mcp/src/relay-client.ts
git commit -m "feat(mcp): relay client — registry methods for register, lookup, invite, directory"
```

---

## Task 6: MCP — Register + Invite Tools

**Files:**
- Create: `mcp/src/tools/register.ts`
- Create: `mcp/src/tools/invite.ts`

- [ ] **Step 1: Implement register tool**

Create `mcp/src/tools/register.ts`:

```typescript
import { createHash } from "node:crypto";
import { LocalStore } from "../store.js";
import { RelayClient } from "../relay-client.js";

export async function registerEmail(
  store: LocalStore,
  email: string
): Promise<{ email_hash: string; message: string }> {
  const data = await store.load();
  const config = await store.getConfig();

  if (!data.identity.identity_key_public) {
    throw new Error("Identity not initialized. Run peer67 setup first.");
  }

  const relay = new RelayClient(process.env.PEER67_RELAY ?? config.default_relay);
  const emailHash = createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex");

  const result = await relay.register({
    email: email.toLowerCase().trim(),
    handle: data.identity.name,
    pub: Buffer.from(data.identity.identity_key_public, "hex").toString("base64"),
    device_id: data.identity.device_id!,
  });

  if (!result.ok) {
    throw new Error(result.error ?? "Registration failed");
  }

  return {
    email_hash: emailHash,
    message: "Check your email for a verification link. I'll wait for you to click it.",
  };
}

export async function pollVerification(
  store: LocalStore,
  emailHash: string,
  maxAttempts: number = 60,
  intervalMs: number = 2000
): Promise<boolean> {
  const data = await store.load();
  const config = await store.getConfig();
  const relay = new RelayClient(process.env.PEER67_RELAY ?? config.default_relay);

  for (let i = 0; i < maxAttempts; i++) {
    const verified = await relay.checkVerification(emailHash, data.identity.device_id!);
    if (verified) {
      await store.updateIdentity({
        email: undefined, // we'll set this from the caller who knows the email
        registered_at: new Date().toISOString(),
      });
      return true;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return false;
}
```

- [ ] **Step 2: Implement invite tool**

Create `mcp/src/tools/invite.ts`:

```typescript
import { createHash } from "node:crypto";
import { LocalStore } from "../store.js";
import { RelayClient } from "../relay-client.js";
import { connectAutoInitiate } from "./connect.js";

export async function inviteByEmail(
  store: LocalStore,
  email: string
): Promise<{ status: "connected" | "invited" | "already_connected"; message: string }> {
  const data = await store.load();
  const config = await store.getConfig();
  const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relayUrl);

  // Check if already connected to someone with this email
  for (const [, conn] of Object.entries(data.connections)) {
    if (conn.email === email.toLowerCase().trim()) {
      return { status: "already_connected", message: `Already connected to ${conn.display_name}.` };
    }
  }

  // Look up if they're registered
  const emailHash = createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex");

  const lookup = await relay.lookup(emailHash);

  if (lookup && lookup.found && lookup.pub && lookup.handle) {
    // They're registered — auto-connect
    await connectAutoInitiate(store, lookup.handle, lookup.pub, relayUrl);
    return {
      status: "connected",
      message: `${lookup.handle} is on Peer67. Establishing encrypted connection — it will complete automatically.`,
    };
  }

  // Not registered — send invite email
  if (!data.identity.identity_key_public) {
    throw new Error("Identity not initialized.");
  }

  const result = await relay.invite({
    target_email: email.toLowerCase().trim(),
    from_handle: data.identity.name,
    from_pub: Buffer.from(data.identity.identity_key_public, "hex").toString("base64"),
    from_relay: relayUrl,
  });

  if (!result.ok && result.error === "already_registered" && result.pub && result.handle) {
    // Race condition: they registered between our lookup and invite
    await connectAutoInitiate(store, result.handle, result.pub, relayUrl);
    return {
      status: "connected",
      message: `${result.handle} is on Peer67. Establishing encrypted connection.`,
    };
  }

  // Store pending invite for background polling
  await store.addPendingInvite({
    email: email.toLowerCase().trim(),
    email_hash: emailHash,
    created_at: new Date().toISOString(),
  });

  return {
    status: "invited",
    message: `Invite sent to ${email}. When they sign up, the connection will happen automatically.`,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add mcp/src/tools/register.ts mcp/src/tools/invite.ts
git commit -m "feat(mcp): register + invite tools — email verification and auto-connect"
```

---

## Task 7: MCP — Auto-Connect via Connect Inbox

**Files:**
- Modify: `mcp/src/tools/connect.ts`

- [ ] **Step 1: Add connectAutoInitiate**

This is called when we discover a registered user and want to auto-connect. It sends an encrypted connection code to their "connect inbox" mailbox.

Add to `mcp/src/tools/connect.ts`:

```typescript
/**
 * Auto-initiate a connection with a registered user.
 * Sends an encrypted connection code to their connect-inbox.
 */
export async function connectAutoInitiate(
  store: LocalStore,
  theirHandle: string,
  theirIdentityPubB64: string,
  relayUrl: string
): Promise<void> {
  const theirIdentityPub = Uint8Array.from(Buffer.from(theirIdentityPubB64, "base64"));

  // Generate ephemeral keypair for this connection
  const eph = generateKeypair();
  const code = encodeConnectionCode(eph.publicKey, relayUrl);

  // Encrypt the connection code so only the target can read it
  // Transport shared secret: X25519(eph_private, their_identity_pub)
  const transportShared = deriveSharedSecret(eph.privateKey, theirIdentityPub);
  const transportKey = deriveEncryptKey(transportShared); // reuse HKDF with "peer67-encrypt" info

  // Import encrypt from crypto
  const { encrypt } = await import("../crypto.js");
  const connectInbox = createHash("sha256")
    .update(Buffer.from(theirIdentityPub))
    .digest("hex");

  // Payload: our identity pub + connection code
  const data = await store.load();
  const payload = JSON.stringify({
    type: "connect_request",
    from_handle: data.identity.name,
    from_pub: data.identity.identity_key_public,
    code,
  });

  const encrypted = encrypt(transportKey, payload, connectInbox);

  // Wire format: eph_pub (32 bytes base64) + "|" + encrypted
  const ephPubB64 = Buffer.from(eph.publicKey).toString("base64");
  const blob = ephPubB64 + "|" + encrypted;

  const relay = new RelayClient(relayUrl);
  await relay.put(connectInbox, blob);

  // Store pending connection (same as connectCreate)
  await store.setPending({
    name: theirHandle,
    connection_code: code,
    private_key: Buffer.from(eph.privateKey).toString("hex"),
    public_key: Buffer.from(eph.publicKey).toString("hex"),
    created_at: new Date().toISOString(),
  });
}

/**
 * Check our connect-inbox for incoming connection requests.
 * Called during background polling.
 */
export async function checkConnectInbox(
  store: LocalStore
): Promise<string | null> {
  const data = await store.load();
  if (!data.identity.identity_key_public || !data.identity.identity_key_private) {
    return null;
  }

  const config = await store.getConfig();
  const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relayUrl);

  const identityPub = Uint8Array.from(Buffer.from(data.identity.identity_key_public, "hex"));
  const identityPriv = Uint8Array.from(Buffer.from(data.identity.identity_key_private, "hex"));

  const connectInbox = createHash("sha256")
    .update(Buffer.from(identityPub))
    .digest("hex");

  const blobs = await relay.get(connectInbox);
  if (blobs.length === 0) return null;

  for (const blob of blobs) {
    try {
      // Parse: eph_pub_b64 + "|" + encrypted
      const sepIdx = blob.blob.indexOf("|");
      if (sepIdx === -1) continue;

      const ephPubB64 = blob.blob.substring(0, sepIdx);
      const encrypted = blob.blob.substring(sepIdx + 1);

      const ephPub = Uint8Array.from(Buffer.from(ephPubB64, "base64"));

      // Derive transport key
      const transportShared = deriveSharedSecret(identityPriv, ephPub);
      const transportKey = deriveEncryptKey(transportShared);

      const { decrypt } = await import("../crypto.js");
      const payloadJson = decrypt(transportKey, encrypted, connectInbox);
      const payload = JSON.parse(payloadJson) as {
        type: string;
        from_handle: string;
        from_pub: string;
        code: string;
      };

      if (payload.type !== "connect_request") continue;

      // Accept the connection code
      await connectAccept(store, payload.from_handle, payload.code);

      // Delete the blob
      await relay.del(connectInbox, blob.id);

      return payload.from_handle;
    } catch {
      // Skip blobs we can't decrypt
      continue;
    }
  }

  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add mcp/src/tools/connect.ts
git commit -m "feat(mcp): auto-connect via connect-inbox — discovery-driven handshake"
```

---

## Task 8: MCP — Update Server + Setup + CLI

**Files:**
- Modify: `mcp/src/index.ts`
- Modify: `mcp/src/setup.ts`

- [ ] **Step 1: Add new tools to MCP server**

Add `peer67_register`, `peer67_invite`, `peer67_directory` tools to the ListToolsRequestSchema handler and CallToolRequestSchema handler in `mcp/src/index.ts`.

Tool definitions:
```typescript
{
  name: "peer67_register",
  description: "Register your email so contacts can find you. Sends a verification link.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Your email address" },
    },
    required: ["email"],
  },
},
{
  name: "peer67_invite",
  description: "Invite someone by email. Auto-connects if they're registered, sends invite email if not.",
  inputSchema: {
    type: "object",
    properties: {
      email: { type: "string", description: "Email of person to invite" },
    },
    required: ["email"],
  },
},
{
  name: "peer67_directory",
  description: "List registered users on the relay, optionally search by name.",
  inputSchema: {
    type: "object",
    properties: {
      search: { type: "string", description: "Optional search query" },
    },
  },
},
```

Tool handlers:
```typescript
case "peer67_register": {
  const email = params.email as string;
  const { registerEmail, pollVerification } = await import("./tools/register.js");
  const { email_hash, message } = await registerEmail(store, email);
  // Start polling in background
  pollVerification(store, email_hash).then(async (verified) => {
    if (verified) {
      await store.updateIdentity({ email });
      // Check for invites after verification
      const relay = new RelayClient(process.env.PEER67_RELAY ?? (await store.getConfig()).default_relay);
      const invites = await relay.getInvites(email_hash);
      if (invites.length > 0) {
        await server.notification({
          method: "notifications/message",
          params: { level: "info", message: `You have ${invites.length} pending connection request(s)!` },
        });
      }
    }
  });
  return text(message);
}

case "peer67_invite": {
  const email = params.email as string;
  const { inviteByEmail } = await import("./tools/invite.js");
  const result = await inviteByEmail(store, email);
  return text(result.message);
}

case "peer67_directory": {
  const search = params.search as string | undefined;
  const config = await store.getConfig();
  const relay = new RelayClient(process.env.PEER67_RELAY ?? config.default_relay);
  const users = await relay.directory(search);
  if (users.length === 0) return text("No users found.");
  const lines = users.map(u => `  ${u.handle}`);
  return text(`Registered users (${users.length}):\n${lines.join("\n")}`);
}
```

- [ ] **Step 2: Update background polling**

Add `checkConnectInbox` and `checkPendingInvites` to the poll cycle:

```typescript
async function pollCycle(): Promise<void> {
  try {
    // 1. Check handshake completion (existing)
    const handshakeName = await connectComplete(store);
    if (handshakeName) {
      await server.notification({
        method: "notifications/message",
        params: { level: "info", message: `Connected with ${handshakeName}!` },
      });
    }

    // 2. Check connect-inbox for auto-connection requests (new)
    const { checkConnectInbox } = await import("./tools/connect.js");
    const inboxName = await checkConnectInbox(store);
    if (inboxName) {
      await server.notification({
        method: "notifications/message",
        params: { level: "info", message: `${inboxName} connected with you!` },
      });
    }

    // 3. Check pending invites — did anyone we invited register? (new)
    const data = await store.load();
    if (data.pending_invites && data.pending_invites.length > 0) {
      const config = await store.getConfig();
      const relay = new RelayClient(process.env.PEER67_RELAY ?? config.default_relay);
      for (const inv of data.pending_invites) {
        const lookup = await relay.lookup(inv.email_hash);
        if (lookup && lookup.found && lookup.pub && lookup.handle) {
          const { connectAutoInitiate } = await import("./tools/connect.js");
          await connectAutoInitiate(store, lookup.handle, lookup.pub, config.default_relay);
          await store.removePendingInvite(inv.email_hash);
          await server.notification({
            method: "notifications/message",
            params: { level: "info", message: `${lookup.handle} joined Peer67! Connecting...` },
          });
        }
      }
    }
  } catch {
    // Silent
  }
}
```

Replace the existing `pollConnections` with `pollCycle`.

- [ ] **Step 3: Update setup.ts to include email registration**

Update the `setup()` function to ask for email after name:

```typescript
// After identity creation:
const email = await prompt("  Email (for discovery, optional): ");
if (email) {
  // Register on relay
  const { registerEmail } = await import("./tools/register.js");
  try {
    const { email_hash } = await registerEmail(store, email);
    process.stdout.write("  Waiting for you to click the verification link...\n");

    const { pollVerification } = await import("./tools/register.js");
    const verified = await pollVerification(store, email_hash, 120, 2000); // 4 min max
    if (verified) {
      await store.updateIdentity({ email });
      process.stdout.write(`  \x1b[32m✓\x1b[0m Email verified (${email})\n`);
    } else {
      process.stdout.write(`  \x1b[33m!\x1b[0m Verification timed out. You can register later in Claude.\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    process.stdout.write(`  \x1b[33m!\x1b[0m Registration failed: ${msg}\n`);
  }
}
```

- [ ] **Step 4: Update CLI with new commands**

Add to the CLI switch in `index.ts`:

```typescript
case "register": {
  const email = rest[0];
  if (!email) { console.log("Usage: peer67 register <email>"); process.exit(1); }
  const { registerEmail, pollVerification } = await import("./tools/register.js");
  const { email_hash } = await registerEmail(store, email);
  console.log("Check your email for the verification link...");
  const verified = await pollVerification(store, email_hash, 120, 2000);
  if (verified) {
    await store.updateIdentity({ email });
    console.log(`Verified! You're discoverable as ${email}`);
  } else {
    console.log("Verification timed out. Try again.");
  }
  break;
}
case "invite": {
  const email = rest[0];
  if (!email) { console.log("Usage: peer67 invite <email>"); process.exit(1); }
  const { inviteByEmail } = await import("./tools/invite.js");
  const result = await inviteByEmail(store, email);
  console.log(result.message);
  break;
}
case "directory": {
  const search = rest[0] || undefined;
  const config = await store.getConfig();
  const relay = new (await import("./relay-client.js")).RelayClient(
    process.env.PEER67_RELAY ?? config.default_relay
  );
  const users = await relay.directory(search);
  if (users.length === 0) { console.log("No users found."); break; }
  for (const u of users) console.log(`  ${u.handle}`);
  break;
}
```

- [ ] **Step 5: Commit**

```bash
git add mcp/src/index.ts mcp/src/setup.ts
git commit -m "feat(mcp): register, invite, directory tools + email setup flow"
```

---

## Task 9: Integration Tests

**Files:**
- Create: `mcp/tests/registry.test.ts`

- [ ] **Step 1: Write integration test for full discovery flow**

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { LocalStore } from "../src/store.js";
import { registerEmail } from "../src/tools/register.js";
import { inviteByEmail } from "../src/tools/invite.js";
import { checkConnectInbox, connectComplete } from "../src/tools/connect.js";
import { sendMessage } from "../src/tools/send.js";
import { checkInbox } from "../src/tools/inbox.js";
import { buildApp } from "../../relay/src/index.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let relay: FastifyInstance;
let relayUrl: string;

beforeAll(async () => {
  relay = await buildApp({ redisUrl: "redis://mock" });
  await relay.listen({ port: 0, host: "127.0.0.1" });
  const addr = relay.addresses()[0];
  relayUrl = `http://${addr.address}:${addr.port}`;
  process.env.PEER67_RELAY = relayUrl;
});

afterAll(async () => {
  delete process.env.PEER67_RELAY;
  await relay.close();
});

describe("discovery flow", () => {
  let aliceDir: string;
  let bobDir: string;
  let aliceStore: LocalStore;
  let bobStore: LocalStore;

  beforeEach(async () => {
    aliceDir = mkdtempSync(join(tmpdir(), "peer67-alice-"));
    bobDir = mkdtempSync(join(tmpdir(), "peer67-bob-"));
    aliceStore = new LocalStore(aliceDir);
    bobStore = new LocalStore(bobDir);
    await aliceStore.init("Alice");
    await bobStore.init("Bob");
  });

  afterEach(() => {
    rmSync(aliceDir, { recursive: true, force: true });
    rmSync(bobDir, { recursive: true, force: true });
  });

  it("registers, looks up, and auto-connects two users", async () => {
    // Alice registers (in test mode, token is returned directly)
    const aliceData = await aliceStore.load();
    const aliceResult = await relay.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "alice@test.com",
        handle: "Alice",
        pub: Buffer.from(aliceData.identity.identity_key_public!, "hex").toString("base64"),
        device_id: aliceData.identity.device_id!,
      },
    });
    const { token: aliceToken } = aliceResult.json();
    await relay.inject({ method: "GET", url: `/r/verify?token=${aliceToken}` });
    await aliceStore.updateIdentity({ email: "alice@test.com" });

    // Bob registers
    const bobData = await bobStore.load();
    const bobResult = await relay.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "bob@test.com",
        handle: "Bob",
        pub: Buffer.from(bobData.identity.identity_key_public!, "hex").toString("base64"),
        device_id: bobData.identity.device_id!,
      },
    });
    const { token: bobToken } = bobResult.json();
    await relay.inject({ method: "GET", url: `/r/verify?token=${bobToken}` });
    await bobStore.updateIdentity({ email: "bob@test.com" });

    // Alice invites Bob by email — should auto-connect since Bob is registered
    const inviteResult = await inviteByEmail(aliceStore, "bob@test.com");
    expect(inviteResult.status).toBe("connected");

    // Bob checks connect-inbox — should find Alice's request and auto-accept
    const connectedName = await checkConnectInbox(bobStore);
    expect(connectedName).toBe("Alice");

    // Alice completes handshake
    const completedName = await connectComplete(aliceStore);
    expect(completedName).toBe("Bob");

    // Verify both sides can message
    await sendMessage(aliceStore, "Bob", "Hello from discovery!");
    const messages = await checkInbox(bobStore, "Alice");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Hello from discovery!");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd mcp && npx vitest run tests/registry.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add mcp/tests/registry.test.ts
git commit -m "test(mcp): discovery flow integration test — register, lookup, auto-connect, message"
```

---

## Task 10: Deploy + Republish

**Files:**
- Modify: `relay/package.json` (version bump)
- Modify: `mcp/package.json` (version bump)

- [ ] **Step 1: Add RESEND_API_KEY to Railway**

```bash
cd relay && railway variables --set "RESEND_API_KEY=<key>" --set "FROM_EMAIL=noreply@peer67.com" --set "RELAY_URL=https://relay-production-a9d5.up.railway.app"
```

- [ ] **Step 2: Deploy relay**

```bash
cd relay && railway up
```

- [ ] **Step 3: Build and publish MCP**

```bash
cd mcp && npm version patch && npm run build && npm publish --access public
```

- [ ] **Step 4: Commit version bumps**

```bash
git add relay/package.json mcp/package.json
git commit -m "chore: version bump — relay + mcp with discovery layer"
```

---

## Summary

| Task | What it builds | Tests |
|------|---------------|-------|
| 1 | Registry store (Redis-backed) | ~12 unit tests |
| 2 | Email service (Resend) | — |
| 3 | Registry HTTP routes (/r/*) | ~8 route tests |
| 4 | Store v2 (identity keypair, email, pending invites) | ~4 tests |
| 5 | Relay client registry methods | — |
| 6 | Register + invite tools | — |
| 7 | Auto-connect via connect-inbox | — |
| 8 | MCP server + setup + CLI updates | — |
| 9 | Discovery flow integration test | 1 E2E test |
| 10 | Deploy + republish | — |

**Total: 10 tasks. Adds ~25 tests. The messaging plane is completely untouched.**
