import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import { buildApp } from "../src/index.js";
import { RegistryStore } from "../src/registry.js";

let app: FastifyInstance;
const mockRedis = new RedisMock() as unknown as Redis;

beforeEach(async () => {
  await (mockRedis as unknown as { flushall(): Promise<void> }).flushall();
  const registry = new RegistryStore(mockRedis);
  app = await buildApp({ redis: mockRedis, registry });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// Helper: register a user and return token + email_hash
async function registerUser(
  email: string,
  handle: string,
  pub = "base64pubkey==",
  device_id = "device-001"
): Promise<{ token: string; email_hash: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/r/register",
    payload: { email, handle, pub, device_id },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string; email_hash: string }>();
}

describe("POST /r/register", () => {
  it("returns email_hash and token in test mode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: {
        email: "alice@example.com",
        handle: "alice",
        pub: "base64pubkey==",
        device_id: "device-001",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ email_hash: string; token: string }>();
    expect(typeof body.email_hash).toBe("string");
    expect(body.email_hash.length).toBe(64);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("returns 400 when email is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { handle: "alice", pub: "key", device_id: "d1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when handle is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { email: "alice@example.com", pub: "key", device_id: "d1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when pub is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { email: "alice@example.com", handle: "alice", device_id: "d1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when device_id is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { email: "alice@example.com", handle: "alice", pub: "key" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 429 after exceeding rate limit", async () => {
    // 3 attempts allowed, 4th should fail
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/r/register",
        payload: { email: "limited@example.com", handle: "limited", pub: "k", device_id: "d" },
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/r/register",
      payload: { email: "limited@example.com", handle: "limited", pub: "k", device_id: "d" },
    });
    expect(res.statusCode).toBe(429);
  });
});

describe("GET /r/verify", () => {
  it("returns HTML success page on valid token", async () => {
    const { token } = await registerUser("alice@example.com", "alice");

    const res = await app.inject({
      method: "GET",
      url: `/r/verify?token=${token}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Verified");
  });

  it("returns HTML error page on invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/verify?token=invalid-token-xyz",
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Invalid");
  });

  it("returns 400 when token param is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/verify",
    });
    expect(res.statusCode).toBe(400);
  });

  it("token is one-time use — second verify fails", async () => {
    const { token } = await registerUser("alice2@example.com", "alice2");

    const first = await app.inject({ method: "GET", url: `/r/verify?token=${token}` });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: `/r/verify?token=${token}` });
    expect(second.statusCode).toBe(400);
  });
});

describe("GET /r/check-verification", () => {
  it("returns verified: false before verification", async () => {
    const { email_hash } = await registerUser("bob@example.com", "bob");

    const res = await app.inject({
      method: "GET",
      url: `/r/check-verification?email_hash=${email_hash}&device_id=device-001`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ verified: boolean }>();
    expect(body.verified).toBe(false);
  });

  it("returns verified: true after verification", async () => {
    const { token, email_hash } = await registerUser("bob@example.com", "bob");

    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({
      method: "GET",
      url: `/r/check-verification?email_hash=${email_hash}&device_id=device-001`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ verified: boolean }>();
    expect(body.verified).toBe(true);
  });

  it("returns 400 when email_hash is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/check-verification?device_id=d1",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when device_id is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/check-verification?email_hash=abc123",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /r/lookup", () => {
  it("returns found: false for unknown email_hash", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/r/lookup?email_hash=${"0".repeat(64)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ found: boolean }>();
    expect(body.found).toBe(false);
  });

  it("returns found: true with handle+pub after verification", async () => {
    const { token, email_hash } = await registerUser("carol@example.com", "carol", "carolpub==");
    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({
      method: "GET",
      url: `/r/lookup?email_hash=${email_hash}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ found: boolean; handle?: string; pub?: string }>();
    expect(body.found).toBe(true);
    expect(body.handle).toBe("carol");
    expect(body.pub).toBe("carolpub==");
  });

  it("returns 400 when email_hash is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/lookup",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /r/directory", () => {
  it("returns empty users array when no one is registered", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/r/directory",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: unknown[] }>();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBe(0);
  });

  it("lists verified users", async () => {
    const { token } = await registerUser("dave@example.com", "dave", "davepub==");
    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({ method: "GET", url: "/r/directory" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: Array<{ handle: string; pub: string }> }>();
    expect(body.users.length).toBe(1);
    expect(body.users[0].handle).toBe("dave");
    expect(body.users[0].pub).toBe("davepub==");
  });

  it("filters users by q parameter", async () => {
    const { token: t1 } = await registerUser("eve1@example.com", "eve");
    const { token: t2 } = await registerUser("frank@example.com", "frank");
    await app.inject({ method: "GET", url: `/r/verify?token=${t1}` });
    await app.inject({ method: "GET", url: `/r/verify?token=${t2}` });

    const res = await app.inject({ method: "GET", url: "/r/directory?q=fr" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ users: Array<{ handle: string }> }>();
    expect(body.users.length).toBe(1);
    expect(body.users[0].handle).toBe("frank");
  });
});

describe("POST /r/invite", () => {
  it("creates an invite for an unregistered target", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: "newuser@example.com",
        from_handle: "alice",
        from_pub: "alicepub==",
        from_relay: "https://relay.peer67.com",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; invite_id: string }>();
    expect(body.ok).toBe(true);
    expect(typeof body.invite_id).toBe("string");
    expect(body.invite_id.length).toBeGreaterThan(0);
  });

  it("returns already_registered error if target is verified", async () => {
    const { token } = await registerUser("registered@example.com", "reguser", "regpub==");
    await app.inject({ method: "GET", url: `/r/verify?token=${token}` });

    const res = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: "registered@example.com",
        from_handle: "someone",
        from_pub: "somepub==",
        from_relay: "https://relay.peer67.com",
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; handle: string; pub: string }>();
    expect(body.error).toBe("already_registered");
    expect(body.handle).toBe("reguser");
    expect(body.pub).toBe("regpub==");
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: { target_email: "someone@example.com" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /r/invites", () => {
  it("returns empty invites array for unknown email_hash", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/r/invites?email_hash=${"0".repeat(64)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ invites: unknown[] }>();
    expect(Array.isArray(body.invites)).toBe(true);
    expect(body.invites.length).toBe(0);
  });

  it("returns invites for an email_hash", async () => {
    const registry = new RegistryStore(mockRedis);
    const targetEmail = "invited@example.com";
    const emailHash = registry.hashEmail(targetEmail);

    await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: targetEmail,
        from_handle: "alice",
        from_pub: "alicepub==",
        from_relay: "https://relay.peer67.com",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/r/invites?email_hash=${emailHash}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ invites: Array<{ id: string; from_handle: string }> }>();
    expect(body.invites.length).toBe(1);
    expect(body.invites[0].from_handle).toBe("alice");
  });

  it("returns 400 when email_hash is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/r/invites" });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /r/invites/:id", () => {
  it("deletes an existing invite", async () => {
    const registry = new RegistryStore(mockRedis);
    const targetEmail = "deleteme@example.com";
    const emailHash = registry.hashEmail(targetEmail);

    const createRes = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: targetEmail,
        from_handle: "alice",
        from_pub: "alicepub==",
        from_relay: "https://relay.peer67.com",
      },
    });
    const { invite_id } = createRes.json<{ invite_id: string }>();

    const res = await app.inject({
      method: "DELETE",
      url: `/r/invites/${invite_id}?email_hash=${emailHash}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("returns ok: false for non-existent invite", async () => {
    const registry = new RegistryStore(mockRedis);
    const emailHash = registry.hashEmail("nobody@example.com");

    const res = await app.inject({
      method: "DELETE",
      url: `/r/invites/nonexistent-id?email_hash=${emailHash}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
  });

  it("returns 400 when email_hash is missing", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/r/invites/some-id",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("Full registration flow", () => {
  it("register → verify → check-verification → lookup → directory → invite → invites → delete", async () => {
    // 1. Register
    const { token, email_hash } = await registerUser("full@example.com", "fulluser", "fullpub==");
    expect(token.length).toBeGreaterThan(0);
    expect(email_hash.length).toBe(64);

    // 2. Verify
    const verifyRes = await app.inject({ method: "GET", url: `/r/verify?token=${token}` });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.body).toContain("Verified");

    // 3. Check verification
    const checkRes = await app.inject({
      method: "GET",
      url: `/r/check-verification?email_hash=${email_hash}&device_id=device-001`,
    });
    expect(checkRes.json<{ verified: boolean }>().verified).toBe(true);

    // 4. Lookup
    const lookupRes = await app.inject({ method: "GET", url: `/r/lookup?email_hash=${email_hash}` });
    const lookup = lookupRes.json<{ found: boolean; handle: string; pub: string }>();
    expect(lookup.found).toBe(true);
    expect(lookup.handle).toBe("fulluser");
    expect(lookup.pub).toBe("fullpub==");

    // 5. Directory
    const dirRes = await app.inject({ method: "GET", url: "/r/directory?q=full" });
    const dir = dirRes.json<{ users: Array<{ handle: string }> }>();
    expect(dir.users.length).toBe(1);
    expect(dir.users[0].handle).toBe("fulluser");

    // 6. Invite
    const inviteRes = await app.inject({
      method: "POST",
      url: "/r/invite",
      payload: {
        target_email: "newbie@example.com",
        from_handle: "fulluser",
        from_pub: "fullpub==",
        from_relay: "https://relay.peer67.com",
      },
    });
    const { invite_id } = inviteRes.json<{ ok: boolean; invite_id: string }>();
    expect(typeof invite_id).toBe("string");

    // 7. Get invites
    const registry = new RegistryStore(mockRedis);
    const newbieHash = registry.hashEmail("newbie@example.com");
    const invitesRes = await app.inject({ method: "GET", url: `/r/invites?email_hash=${newbieHash}` });
    const { invites } = invitesRes.json<{ invites: Array<{ id: string; from_handle: string }> }>();
    expect(invites.length).toBe(1);
    expect(invites[0].from_handle).toBe("fulluser");

    // 8. Delete invite
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/r/invites/${invite_id}?email_hash=${newbieHash}`,
    });
    expect(deleteRes.json<{ ok: boolean }>().ok).toBe(true);

    // 9. Verify invites empty
    const emptyRes = await app.inject({ method: "GET", url: `/r/invites?email_hash=${newbieHash}` });
    expect(emptyRes.json<{ invites: unknown[] }>().invites.length).toBe(0);
  });
});
