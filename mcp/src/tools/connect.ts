import { createHash } from "node:crypto";
import {
  generateKeypair,
  deriveSharedSecret,
  deriveMailboxIds,
  deriveEncryptKey,
} from "../crypto.js";
import { encodeConnectionCode, decodeConnectionCode } from "../codec.js";
import { LocalStore, ConnectionData } from "../store.js";
import { RelayClient } from "../relay-client.js";

export async function connectCreate(
  store: LocalStore,
  name: string,
  relayUrl?: string
): Promise<{ code: string; message: string }> {
  const config = await store.getConfig();
  const relay = relayUrl ?? config.default_relay;

  const keypair = generateKeypair();
  const code = encodeConnectionCode(keypair.publicKey, relay);

  await store.setPending({
    name,
    connection_code: code,
    private_key: Buffer.from(keypair.privateKey).toString("hex"),
    public_key: Buffer.from(keypair.publicKey).toString("hex"),
    created_at: new Date().toISOString(),
  });

  return {
    code,
    message: `Share this code with ${name} to connect. Run connect_complete after they accept.`,
  };
}

export async function connectAccept(
  store: LocalStore,
  name: string,
  code: string
): Promise<{ connected: boolean; name: string; message: string }> {
  const decoded = decodeConnectionCode(code);
  const initiatorPublicKey = decoded.publicKey;
  const relayUrl = decoded.relayUrl;

  const keypair = generateKeypair();
  const sharedSecret = deriveSharedSecret(keypair.privateKey, initiatorPublicKey);
  const { mailboxAtoB, mailboxBtoA } = deriveMailboxIds(sharedSecret);
  const encryptKey = deriveEncryptKey(sharedSecret);

  // Acceptor (B): writes to mailbox_b_to_a, reads from mailbox_a_to_b
  const conn: ConnectionData = {
    display_name: name,
    mailbox_send: Buffer.from(mailboxBtoA).toString("hex"),
    mailbox_recv: Buffer.from(mailboxAtoB).toString("hex"),
    shared_key: Buffer.from(encryptKey).toString("hex"),
    relay_url: relayUrl,
    created_at: new Date().toISOString(),
  };

  await store.addConnection(name, conn);

  // Send our public key to rendezvous mailbox = SHA256(initiator_public_key)
  const rendezvousMailbox = createHash("sha256")
    .update(initiatorPublicKey)
    .digest("hex");

  const relay = new RelayClient(relayUrl);
  const ourPublicKeyB64 = Buffer.from(keypair.publicKey).toString("base64");
  await relay.put(rendezvousMailbox, ourPublicKeyB64);

  return {
    connected: true,
    name,
    message: `Accepted connection with ${name}. Waiting for them to complete the handshake.`,
  };
}

export async function connectComplete(store: LocalStore): Promise<string | null> {
  const data = await store.load();
  const pending = data.pending;
  if (!pending) {
    return null;
  }

  const ourPublicKeyBytes = Buffer.from(pending.public_key, "hex");

  // Rendezvous mailbox = SHA256(our public key)
  const rendezvousMailbox = createHash("sha256")
    .update(ourPublicKeyBytes)
    .digest("hex");

  const decoded = decodeConnectionCode(pending.connection_code);
  const relayUrl = decoded.relayUrl;

  const relay = new RelayClient(relayUrl);
  const blobs = await relay.get(rendezvousMailbox);

  if (blobs.length === 0) {
    return null;
  }

  const blob = blobs[0];
  const theirPublicKeyBytes = Buffer.from(blob.blob, "base64");

  const ourPrivateKeyBytes = Buffer.from(pending.private_key, "hex");
  const sharedSecret = deriveSharedSecret(ourPrivateKeyBytes, theirPublicKeyBytes);
  const { mailboxAtoB, mailboxBtoA } = deriveMailboxIds(sharedSecret);
  const encryptKey = deriveEncryptKey(sharedSecret);

  // Initiator (A): writes to mailbox_a_to_b, reads from mailbox_b_to_a
  const conn: ConnectionData = {
    display_name: pending.name,
    mailbox_send: Buffer.from(mailboxAtoB).toString("hex"),
    mailbox_recv: Buffer.from(mailboxBtoA).toString("hex"),
    shared_key: Buffer.from(encryptKey).toString("hex"),
    relay_url: relayUrl,
    created_at: new Date().toISOString(),
  };

  await store.addConnection(pending.name, conn);
  await relay.del(rendezvousMailbox, blob.id);
  await store.clearPending();

  return pending.name;
}
