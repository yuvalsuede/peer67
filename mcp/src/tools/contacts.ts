import { LocalStore } from "../store.js";

export interface ContactInfo {
  name: string;
  display_name: string;
  relay_url: string;
  connected_at: string;
  last_seen: string;
}

export async function listContacts(store: LocalStore): Promise<ContactInfo[]> {
  return store.listConnections();
}

export async function disconnectContact(
  store: LocalStore,
  name: string
): Promise<{ disconnected: boolean }> {
  const conn = await store.getConnection(name);
  if (!conn) {
    throw new Error(`No connection found for "${name}"`);
  }

  await store.removeConnection(name);
  return { disconnected: true };
}
