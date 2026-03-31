import { encrypt } from "../crypto.js";
import { LocalStore } from "../store.js";
import { RelayClient } from "../relay-client.js";

export async function sendMessage(
  store: LocalStore,
  to: string,
  message: string
): Promise<{ sent: boolean; expires_at: string }> {
  const conn = await store.getConnection(to);
  if (!conn) {
    throw new Error(`No connection found for "${to}"`);
  }

  const envelope = JSON.stringify({
    v: 1,
    t: Math.floor(Date.now() / 1000),
    b: message,
  });

  const sharedKey = Buffer.from(conn.shared_key, "hex");
  const encrypted = encrypt(sharedKey, envelope, conn.mailbox_send);

  const relay = new RelayClient(conn.relay_url);
  const { expires_at } = await relay.put(conn.mailbox_send, encrypted);

  return { sent: true, expires_at };
}
