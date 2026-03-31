import { createHash } from "node:crypto";
import { LocalStore } from "../store.js";
import { RelayClient } from "../relay-client.js";
import { connectAutoInitiate } from "./connect.js";

type InviteStatus = "connected" | "invited" | "already_connected";

export interface InviteResult {
  status: InviteStatus;
  message: string;
}

function computeEmailHash(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

export async function inviteByEmail(
  store: LocalStore,
  email: string
): Promise<InviteResult> {
  const data = await store.load();
  const config = await store.getConfig();

  const normalizedEmail = email.trim().toLowerCase();

  // Check if already connected (scan connections for matching email)
  for (const [, conn] of Object.entries(data.connections)) {
    if (conn.email?.trim().toLowerCase() === normalizedEmail) {
      return {
        status: "already_connected",
        message: `Already connected to ${conn.display_name}.`,
      };
    }
  }

  const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relayUrl);

  const email_hash = computeEmailHash(normalizedEmail);
  const lookup = await relay.lookup(email_hash);

  if (lookup?.found && lookup.pub) {
    // Peer is registered — auto-initiate connection
    await connectAutoInitiate(store, email, lookup.pub, relayUrl);
    return {
      status: "connected",
      message: `Connection initiated with ${email}. Run connect_complete once they accept.`,
    };
  }

  // Peer not found — send an invite email
  if (!data.identity.identity_key_public) {
    throw new Error("Identity key not initialized. Run init first.");
  }

  const fromPub = Buffer.from(data.identity.identity_key_public, "hex").toString("base64");

  const result = await relay.invite({
    target_email: email,
    from_handle: data.identity.name,
    from_pub: fromPub,
    from_relay: relayUrl,
  });

  if (!result.ok) {
    throw new Error(`Invite failed: ${result.error ?? "unknown error"}`);
  }

  await store.addPendingInvite({
    email: normalizedEmail,
    email_hash,
    created_at: new Date().toISOString(),
  });

  return {
    status: "invited",
    message: `Invite sent to ${email}. They will receive an email to join Peer67.`,
  };
}
