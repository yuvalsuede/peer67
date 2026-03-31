import { LocalStore } from "./mcp/src/store.js";
import { connectCreate, connectAccept, connectComplete } from "./mcp/src/tools/connect.js";
import { sendMessage } from "./mcp/src/tools/send.js";
import { checkInbox, acknowledgeMessages } from "./mcp/src/tools/inbox.js";
import { listContacts } from "./mcp/src/tools/contacts.js";
import { join } from "node:path";
import { homedir } from "node:os";

const store = new LocalStore(join(homedir(), ".peer67"));
const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "init": {
      const name = args[0];
      if (!name) { console.log("Usage: cli.ts init <name>"); return; }
      await store.init(name);
      const data = await store.load();
      console.log(`Initialized as "${data.identity.name}"`);
      break;
    }
    case "connect": {
      const name = args[0];
      if (!name) { console.log("Usage: cli.ts connect <name>"); return; }
      const { code, message } = await connectCreate(store, name);
      console.log(`\nConnection code for ${name}:\n`);
      console.log(`  ${code}\n`);
      console.log(message);
      break;
    }
    case "accept": {
      const name = args[0];
      const code = args[1];
      if (!name || !code) { console.log("Usage: cli.ts accept <name> <code>"); return; }
      const result = await connectAccept(store, name, code);
      console.log(result.message);
      break;
    }
    case "complete": {
      const name = await connectComplete(store);
      if (name) {
        console.log(`Connection completed with ${name}!`);
      } else {
        console.log("No pending connections completed yet.");
      }
      break;
    }
    case "send": {
      const to = args[0];
      const msg = args.slice(1).join(" ");
      if (!to || !msg) { console.log("Usage: cli.ts send <name> <message>"); return; }
      const result = await sendMessage(store, to, msg);
      console.log(`Sent to ${to}. Expires: ${result.expires_at}`);
      break;
    }
    case "inbox": {
      const from = args[0] || undefined;
      const messages = await checkInbox(store, from);
      if (messages.length === 0) {
        console.log("No new messages.");
        return;
      }
      for (const m of messages) {
        const ago = timeAgo(new Date(m.timestamp));
        console.log(`${m.from} (${ago}): "${m.body}"`);
      }
      await acknowledgeMessages(messages);
      console.log(`\n${messages.length} message(s) acknowledged.`);
      break;
    }
    case "contacts": {
      const contacts = await listContacts(store);
      if (contacts.length === 0) { console.log("No contacts."); return; }
      for (const c of contacts) {
        console.log(`  ${c.display_name} (${c.relay_url})`);
      }
      break;
    }
    case "status": {
      const data = await store.load();
      console.log(`Identity: ${data.identity.name}`);
      console.log(`Connections: ${Object.keys(data.connections).length}`);
      console.log(`Pending: ${data.pending ? data.pending.name : "none"}`);
      break;
    }
    default:
      console.log("Commands: init, connect, accept, complete, send, inbox, contacts, status");
  }
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
