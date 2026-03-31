import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";

export interface ConnectionData {
  display_name: string;
  mailbox_send: string; // hex
  mailbox_recv: string; // hex
  shared_key: string;   // hex
  relay_url: string;
  email?: string;
  created_at?: string;
  last_seen?: string;
}

export interface PendingConnection {
  name: string;
  connection_code: string;
  private_key: string; // hex
  public_key: string;  // hex
  created_at?: string;
}

export interface StoreData {
  version: number;
  identity: {
    name: string;
    created_at: string;
    email?: string;
    identity_key_private?: string; // hex
    identity_key_public?: string;  // hex
    device_id?: string;            // hex
    registered_at?: string;
  };
  connections: Record<string, ConnectionData>;
  pending?: PendingConnection;
  pending_invites?: Array<{ email: string; email_hash: string; created_at: string }>;
}

interface Config {
  default_relay: string;
  poll_interval_seconds: number;
}

const STORE_VERSION = 1;
const DEFAULT_RELAY = "https://relay-production-a9d5.up.railway.app";
const DEFAULT_POLL_INTERVAL = 5;
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(): Buffer {
  const host = hostname();
  const user = userInfo().username;
  const material = `${host}:${user}:peer67`;
  return createHash("sha256").update(material).digest();
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Format: base64 of iv(12B) + authTag(16B) + ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

function decrypt(encoded: string, key: Buffer): string {
  const combined = Buffer.from(encoded, "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

export class LocalStore {
  private readonly storePath: string;
  private readonly configPath: string;

  constructor(private readonly dir: string) {
    this.storePath = join(dir, "store.json");
    this.configPath = join(dir, "config.json");
  }

  async init(name: string): Promise<void> {
    // Create directory if needed
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }

    // Create config.json if absent (plain JSON, not encrypted)
    if (!existsSync(this.configPath)) {
      const config: Config = {
        default_relay: DEFAULT_RELAY,
        poll_interval_seconds: DEFAULT_POLL_INTERVAL,
      };
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
    }

    // Create store.json if absent (encrypted)
    if (!existsSync(this.storePath)) {
      const { generateKeypair } = await import("./crypto.js");
      const keypair = generateKeypair();
      const host = hostname();
      const user = userInfo().username;
      const device_id = createHash("sha256")
        .update(`${host}:${user}`)
        .digest("hex");

      const initial: StoreData = {
        version: STORE_VERSION,
        identity: {
          name,
          created_at: new Date().toISOString(),
          identity_key_private: Buffer.from(keypair.privateKey).toString("hex"),
          identity_key_public: Buffer.from(keypair.publicKey).toString("hex"),
          device_id,
        },
        connections: {},
      };
      this.writeStore(initial);
    }
  }

  async load(): Promise<StoreData> {
    const raw = readFileSync(this.storePath, "utf8");
    const key = deriveKey();
    const plaintext = decrypt(raw.trim(), key);
    return JSON.parse(plaintext) as StoreData;
  }

  async addConnection(name: string, conn: ConnectionData): Promise<void> {
    const data = await this.load();
    const updated: StoreData = {
      ...data,
      connections: { ...data.connections, [name]: conn },
    };
    this.writeStore(updated);
  }

  async removeConnection(name: string): Promise<void> {
    const data = await this.load();
    const { [name]: _removed, ...rest } = data.connections;
    const updated: StoreData = { ...data, connections: rest };
    this.writeStore(updated);
  }

  async listConnections(): Promise<
    Array<{
      name: string;
      display_name: string;
      relay_url: string;
      connected_at: string;
      last_seen: string;
    }>
  > {
    const data = await this.load();
    return Object.entries(data.connections).map(([name, conn]) => ({
      name,
      display_name: conn.display_name,
      relay_url: conn.relay_url,
      connected_at: conn.created_at ?? "",
      last_seen: conn.last_seen ?? "",
    }));
  }

  async getConnection(name: string): Promise<ConnectionData | undefined> {
    const data = await this.load();
    return data.connections[name];
  }

  async setPending(pending: PendingConnection): Promise<void> {
    const data = await this.load();
    const updated: StoreData = { ...data, pending };
    this.writeStore(updated);
  }

  async clearPending(): Promise<void> {
    const data = await this.load();
    const { pending: _removed, ...rest } = data;
    this.writeStore(rest as StoreData);
  }

  async updateIdentity(updates: Partial<StoreData["identity"]>): Promise<void> {
    const data = await this.load();
    const updated: StoreData = {
      ...data,
      identity: { ...data.identity, ...updates },
    };
    this.writeStore(updated);
  }

  async addPendingInvite(invite: {
    email: string;
    email_hash: string;
    created_at: string;
  }): Promise<void> {
    const data = await this.load();
    const existing = data.pending_invites ?? [];
    const updated: StoreData = {
      ...data,
      pending_invites: [...existing, invite],
    };
    this.writeStore(updated);
  }

  async removePendingInvite(emailHash: string): Promise<void> {
    const data = await this.load();
    const existing = data.pending_invites ?? [];
    const updated: StoreData = {
      ...data,
      pending_invites: existing.filter((inv) => inv.email_hash !== emailHash),
    };
    this.writeStore(updated);
  }

  async getConfig(): Promise<Config> {
    if (!existsSync(this.configPath)) {
      return {
        default_relay: DEFAULT_RELAY,
        poll_interval_seconds: DEFAULT_POLL_INTERVAL,
      };
    }
    const raw = readFileSync(this.configPath, "utf8");
    return JSON.parse(raw) as Config;
  }

  private writeStore(data: StoreData): void {
    const key = deriveKey();
    const plaintext = JSON.stringify(data);
    const encrypted = encrypt(plaintext, key);
    writeFileSync(this.storePath, encrypted, "utf8");
  }
}
