import type { Redis } from "ioredis";
import type { ServerResponse } from "node:http";

export class NotifyHub {
  private readonly locals = new Map<string, Set<ServerResponse>>();
  private eventCounter = 0;

  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    this.sub.on("message", (channel: string, message: string) => {
      const streams = this.locals.get(channel);
      if (!streams) return;
      this.eventCounter++;
      for (const res of streams) {
        try {
          res.write(`id: ${this.eventCounter}\nevent: blob\ndata: ${message}\n\n`);
        } catch {
          // Client disconnected
        }
      }
    });
  }

  async subscribe(mailboxId: string, res: ServerResponse): Promise<void> {
    const channel = `notify:${mailboxId}`;
    if (!this.locals.has(channel)) {
      this.locals.set(channel, new Set());
      await this.sub.subscribe(channel);
    }
    this.locals.get(channel)!.add(res);
  }

  async unsubscribe(mailboxId: string, res: ServerResponse): Promise<void> {
    const channel = `notify:${mailboxId}`;
    const set = this.locals.get(channel);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
      this.locals.delete(channel);
      await this.sub.unsubscribe(channel);
    }
  }

  async publish(mailboxId: string, blobId: string): Promise<void> {
    const event = JSON.stringify({ mailbox: mailboxId, blob_id: blobId, ts: Date.now() });
    await this.pub.publish(`notify:${mailboxId}`, event);
  }
}
