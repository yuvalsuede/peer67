import { createHash } from "node:crypto";
import {
  generateKeypair,
  deriveSharedSecret,
  deriveMailboxIds,
  deriveEncryptKey,
  encrypt,
  decrypt,
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
  const relay = relayUrl ?? process.env.PEER67_RELAY ?? config.default_relay;

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

export async function connectAutoInitiate(
  store: LocalStore,
  theirHandle: string,
  theirIdentityPubB64: string,
  relayUrl?: string
): Promise<void> {
  const config = await store.getConfig();
  const relay_url = relayUrl ?? process.env.PEER67_RELAY ?? config.default_relay;

  const data = await store.load();
  const fromHandle = data.identity.name;
  const ourIdentityPubHex = data.identity.identity_key_public;
  if (!ourIdentityPubHex) {
    throw new Error("No identity key found. Run init first.");
  }

  // 1. Decode their identity public key from base64
  const theirIdentityPub = Buffer.from(theirIdentityPubB64, "base64");

  // 2. Generate ephemeral keypair
  const ephKeypair = generateKeypair();

  // 3. Encode connection code using ephemeral public key + relay URL
  const code = encodeConnectionCode(ephKeypair.publicKey, relay_url);

  // 4. Derive transport key: X25519(eph_private, their_identity_pub)
  const transportShared = deriveSharedSecret(ephKeypair.privateKey, theirIdentityPub);
  const transportKey = deriveEncryptKey(transportShared);

  // 5. Compute their connect-inbox mailbox
  const connectInbox = createHash("sha256")
    .update("peer67-connect-inbox:" + Buffer.from(theirIdentityPub).toString("hex"))
    .digest("hex");

  // 6. Build payload JSON
  const payload = JSON.stringify({
    type: "connect_request",
    from_handle: fromHandle,
    from_pub: ourIdentityPubHex,
    code,
  });

  // 7. Encrypt payload with transportKey, using connect-inbox mailbox as AAD
  const encrypted = encrypt(transportKey, payload, connectInbox);

  // 8. Wire format blob: base64(eph_pub) + "|" + encrypted
  const ephPubB64 = Buffer.from(ephKeypair.publicKey).toString("base64");
  const blob = ephPubB64 + "|" + encrypted;

  // 9. PUT blob to connect-inbox on relay
  const relay = new RelayClient(relay_url);
  await relay.put(connectInbox, blob);

  // 10. Store pending connection locally (same as connectCreate)
  await store.setPending({
    name: theirHandle,
    connection_code: code,
    private_key: Buffer.from(ephKeypair.privateKey).toString("hex"),
    public_key: Buffer.from(ephKeypair.publicKey).toString("hex"),
    created_at: new Date().toISOString(),
  });
}

export async function checkConnectInbox(store: LocalStore): Promise<string | null> {
  // 1. Load store, get our identity keypair
  const data = await store.load();
  const ourIdentityPrivHex = data.identity.identity_key_private;
  const ourIdentityPubHex = data.identity.identity_key_public;

  if (!ourIdentityPrivHex || !ourIdentityPubHex) {
    return null;
  }

  const ourIdentityPriv = Buffer.from(ourIdentityPrivHex, "hex");
  const ourIdentityPub = Buffer.from(ourIdentityPubHex, "hex");

  // 2. Compute our connect-inbox mailbox
  const connectInbox = createHash("sha256")
    .update("peer67-connect-inbox:" + ourIdentityPub.toString("hex"))
    .digest("hex");

  const config = await store.getConfig();
  const relay_url = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relay_url);

  // 3. GET blobs from relay at connect-inbox
  const blobs = await relay.get(connectInbox);

  // 4. For each blob, attempt to decrypt and process
  for (const relayBlob of blobs) {
    try {
      // a. Split on "|" to get eph_pub_b64 and encrypted part
      const pipeIndex = relayBlob.blob.indexOf("|");
      if (pipeIndex === -1) {
        continue;
      }
      const ephPubB64 = relayBlob.blob.slice(0, pipeIndex);
      const encryptedPart = relayBlob.blob.slice(pipeIndex + 1);

      // b. Decode eph_pub from base64
      const ephPub = Buffer.from(ephPubB64, "base64");

      // c. Derive transport key: X25519(our_identity_private, eph_pub)
      const transportShared = deriveSharedSecret(ourIdentityPriv, ephPub);
      const transportKey = deriveEncryptKey(transportShared);

      // d. Decrypt using transportKey with connect-inbox as AAD
      const plaintext = decrypt(transportKey, encryptedPart, connectInbox);

      // e. Parse JSON payload, verify type === "connect_request"
      const parsed = JSON.parse(plaintext) as {
        type: string;
        from_handle: string;
        from_pub: string;
        code: string;
      };

      if (parsed.type !== "connect_request") {
        continue;
      }

      // f. Store as incoming request (don't auto-accept — wait for user approval)
      await store.addIncomingRequest({
        from_handle: parsed.from_handle,
        from_pub: parsed.from_pub,
        code: parsed.code,
        created_at: new Date().toISOString(),
      });

      // g. DELETE the blob from connect-inbox (we stored it locally)
      await relay.del(connectInbox, relayBlob.id);

      // h. Return from_handle so the caller can notify the user
      return parsed.from_handle;
    } catch {
      // Silently skip blobs that fail decryption (could be garbage)
      continue;
    }
  }

  return null;
}

/**
 * Accept an incoming connection request.
 */
export async function acceptRequest(
  store: LocalStore,
  fromHandle: string
): Promise<{ accepted: boolean; message: string }> {
  const requests = await store.getIncomingRequests();
  const request = requests.find(r => r.from_handle === fromHandle);
  if (!request) {
    throw new Error(`No pending request from "${fromHandle}".`);
  }

  await connectAccept(store, request.from_handle, request.code);
  await store.removeIncomingRequest(fromHandle);

  return {
    accepted: true,
    message: `Connected with ${fromHandle}! You can now exchange messages.`,
  };
}

/**
 * Decline an incoming connection request.
 */
export async function declineRequest(
  store: LocalStore,
  fromHandle: string
): Promise<{ declined: boolean; message: string }> {
  await store.removeIncomingRequest(fromHandle);
  return {
    declined: true,
    message: `Declined connection from ${fromHandle}.`,
  };
}
