import { decrypt } from "../crypto.js";
import { LocalStore, ConnectionData } from "../store.js";
import { RelayClient } from "../relay-client.js";

export interface InboxMessage {
  from: string;
  body: string;
  timestamp: string;
  blob_id: string;
  relay_url: string;
  mailbox: string;
}

interface MessageEnvelope {
  v: number;
  t: number;
  b: string;
}

export async function checkInbox(
  store: LocalStore,
  from?: string
): Promise<InboxMessage[]> {
  const data = await store.load();
  const connections = data.connections;

  const names = from ? [from] : Object.keys(connections);

  const results: InboxMessage[] = [];

  for (const name of names) {
    const conn: ConnectionData | undefined = connections[name];
    if (!conn) {
      continue;
    }

    const relay = new RelayClient(conn.relay_url);
    let blobs;
    try {
      blobs = await relay.get(conn.mailbox_recv);
    } catch {
      continue;
    }

    const sharedKey = Buffer.from(conn.shared_key, "hex");

    for (const blob of blobs) {
      let envelope: MessageEnvelope;
      try {
        const plaintext = decrypt(sharedKey, blob.blob, conn.mailbox_recv);
        envelope = JSON.parse(plaintext) as MessageEnvelope;
      } catch {
        // Could be a handshake blob or corrupted — skip it
        continue;
      }

      results.push({
        from: name,
        body: envelope.b,
        timestamp: new Date(envelope.t * 1000).toISOString(),
        blob_id: blob.id,
        relay_url: conn.relay_url,
        mailbox: conn.mailbox_recv,
      });
    }
  }

  // Sort newest first
  results.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));

  return results;
}

export async function acknowledgeMessages(messages: InboxMessage[]): Promise<void> {
  for (const msg of messages) {
    const relay = new RelayClient(msg.relay_url);
    await relay.del(msg.mailbox, msg.blob_id);
  }
}
