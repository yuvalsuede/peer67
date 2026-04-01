export interface RelayBlob {
  id: string;
  blob: string;
  ts: number;
}

export class RelayClient {
  constructor(private readonly baseUrl: string) {}

  async put(mailboxId: string, blob: string): Promise<{ id: string; expires_at: string }> {
    const res = await fetch(`${this.baseUrl}/d/${mailboxId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Relay PUT failed: ${res.status} ${(body as any).error || ""}`);
    }
    return res.json() as Promise<{ id: string; expires_at: string }>;
  }

  async get(mailboxId: string, after?: number): Promise<RelayBlob[]> {
    const url = after !== undefined
      ? `${this.baseUrl}/d/${mailboxId}?after=${after}`
      : `${this.baseUrl}/d/${mailboxId}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Relay GET failed: ${res.status}`);
    }
    const body = await res.json() as { blobs: RelayBlob[] };
    return body.blobs;
  }

  async del(mailboxId: string, blobId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/d/${mailboxId}/${blobId}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Relay DELETE failed: ${res.status}`);
    }
  }

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

  subscribe(
    mailboxIds: string[],
    onNotify: (event: { mailbox: string; blob_id: string; ts: number }) => void,
    onError?: (err: Error) => void,
    onConnect?: () => void,
  ): { stop: () => void; updateMailboxes: (ids: string[]) => void } {
    let controller = new AbortController();
    let currentIds = [...mailboxIds];
    let running = true;
    let reconnectMs = 1000;
    const maxReconnectMs = 30000;

    const connect = async (ids: string[]) => {
      if (!running || ids.length === 0) return;
      controller = new AbortController();
      const url = `${this.baseUrl}/subscribe?mailboxes=${ids.join(",")}`;

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });

        if (!res.ok || !res.body) throw new Error(`SSE failed: ${res.status}`);

        reconnectMs = 1000;
        onConnect?.();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (running) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const dataLine = frame.split("\n").find(l => l.startsWith("data: "));
            if (dataLine) {
              try {
                onNotify(JSON.parse(dataLine.slice(6)));
              } catch { /* skip bad JSON */ }
            }
          }
        }
      } catch (err: unknown) {
        if (!running) return;
        if ((err as Error).name !== "AbortError") {
          onError?.(err as Error);
        }
      }

      if (running) {
        setTimeout(() => connect(currentIds), reconnectMs);
        reconnectMs = Math.min(reconnectMs * 2, maxReconnectMs);
      }
    };

    connect(currentIds);

    return {
      stop: () => { running = false; controller.abort(); },
      updateMailboxes: (ids: string[]) => {
        currentIds = [...ids];
        controller.abort(); // will reconnect with new IDs
      },
    };
  }
}
