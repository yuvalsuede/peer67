import type { Redis } from "ioredis";
import { nanoid } from "nanoid";

const MAX_BLOB_SIZE = 65536; // 64KB
const MAX_BLOBS_PER_MAILBOX = 1000;
const TTL_SECONDS = 86400; // 24 hours
const MAILBOX_ID_REGEX = /^[0-9a-f]{64}$/;

interface Blob {
  id: string;
  blob: string;
  ts: number;
}

interface PutResult {
  id: string;
  expires_at: string;
}

export class BlobStore {
  constructor(private readonly redis: Redis) {}

  async put(mailboxId: string, blob: string): Promise<PutResult> {
    if (!MAILBOX_ID_REGEX.test(mailboxId)) {
      throw new Error("Invalid mailbox ID: must be 64 lowercase hex characters");
    }

    if (blob.length > MAX_BLOB_SIZE) {
      throw new Error(
        `Blob too large: ${blob.length} bytes exceeds the ${MAX_BLOB_SIZE}-byte limit`
      );
    }

    const key = `mb:${mailboxId}`;

    const count = await this.redis.llen(key);
    if (count >= MAX_BLOBS_PER_MAILBOX) {
      throw new Error(
        `Mailbox full: cannot store more than ${MAX_BLOBS_PER_MAILBOX} blobs`
      );
    }

    const id = nanoid();
    const ts = Date.now();
    const entry: Blob = { id, blob, ts };

    await this.redis.rpush(key, JSON.stringify(entry));
    await this.redis.expire(key, TTL_SECONDS);

    const expiresAt = new Date(ts + TTL_SECONDS * 1000).toISOString();
    return { id, expires_at: expiresAt };
  }

  async get(mailboxId: string, after?: number): Promise<Blob[]> {
    const key = `mb:${mailboxId}`;
    const raw = await this.redis.lrange(key, 0, -1);

    const blobs: Blob[] = raw.map((item) => JSON.parse(item) as Blob);

    if (after === undefined) {
      return blobs;
    }

    return blobs.filter((b) => b.ts > after);
  }

  async del(mailboxId: string, blobId: string): Promise<boolean> {
    const key = `mb:${mailboxId}`;
    const raw = await this.redis.lrange(key, 0, -1);

    const target = raw.find((item) => {
      const parsed = JSON.parse(item) as Blob;
      return parsed.id === blobId;
    });

    if (target === undefined) {
      return false;
    }

    // LREM count=1 removes the first occurrence matching the value
    const removed = await this.redis.lrem(key, 1, target);
    return removed > 0;
  }
}
