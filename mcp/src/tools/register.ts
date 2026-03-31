import { createHash } from "node:crypto";
import { LocalStore } from "../store.js";
import { RelayClient } from "../relay-client.js";

function computeEmailHash(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function registerEmail(
  store: LocalStore,
  email: string
): Promise<{ email_hash: string; message: string }> {
  const data = await store.load();
  const config = await store.getConfig();
  const { identity } = data;

  if (!identity.identity_key_public) {
    throw new Error("Identity key not initialized. Run init first.");
  }
  if (!identity.device_id) {
    throw new Error("Device ID not initialized. Run init first.");
  }

  const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relayUrl);

  const pub = Buffer.from(identity.identity_key_public, "hex").toString("base64");
  const email_hash = computeEmailHash(email);

  const result = await relay.register({
    email,
    handle: identity.name,
    pub,
    device_id: identity.device_id,
  });

  if (!result.ok) {
    throw new Error(`Registration failed: ${result.error ?? "unknown error"}`);
  }

  await store.updateIdentity({ email, registered_at: new Date().toISOString() });

  return {
    email_hash,
    message: "Check your email to verify your address.",
  };
}

export async function pollVerification(
  store: LocalStore,
  email_hash: string,
  maxAttempts = 60,
  intervalMs = 2000
): Promise<boolean> {
  const data = await store.load();
  const config = await store.getConfig();

  if (!data.identity.device_id) {
    throw new Error("Device ID not initialized.");
  }

  const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
  const relay = new RelayClient(relayUrl);
  const { device_id } = data.identity;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const verified = await relay.checkVerification(email_hash, device_id);
    if (verified) {
      return true;
    }
    if (attempt < maxAttempts - 1) {
      await sleep(intervalMs);
    }
  }

  return false;
}
