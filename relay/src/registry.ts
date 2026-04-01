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

    // Rate limit: max 3 registration attempts per email per hour
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

    // Delete token — one-time use
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

    // Add to directory index for listing
    await this.redis.sadd("dir:index", data.email_hash);

    // Set short-lived verification flag for MCP polling
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
    const seen = new Set<string>();
    const results: Array<{ handle: string; pub: string }> = [];

    for (const hash of hashes) {
      const raw = await this.redis.get(`dir:${hash}`);
      if (!raw) {
        // Stale index entry — clean it up
        await this.redis.srem("dir:index", hash);
        continue;
      }
      const entry = JSON.parse(raw) as DirectoryEntry;
      if (search && !entry.handle.toLowerCase().startsWith(search.toLowerCase())) {
        continue;
      }
      // Deduplicate by public key (same person, multiple registrations)
      if (seen.has(entry.pub)) continue;
      seen.add(entry.pub);
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
