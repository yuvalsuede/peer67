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
}
