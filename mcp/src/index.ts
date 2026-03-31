#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LocalStore } from "./store.js";
import { connectCreate, connectAccept, connectComplete, checkConnectInbox, connectAutoInitiate } from "./tools/connect.js";
import { sendMessage } from "./tools/send.js";
import { checkInbox, acknowledgeMessages } from "./tools/inbox.js";
import { listContacts, disconnectContact } from "./tools/contacts.js";
import { registerEmail, pollVerification } from "./tools/register.js";
import { inviteByEmail } from "./tools/invite.js";
import { RelayClient } from "./relay-client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function text(content: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: content }] };
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Store setup ────────────────────────────────────────────────────────────

const storeDir = process.env.PEER67_DIR ?? join(homedir(), ".peer67");
const store = new LocalStore(storeDir);

// ── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "peer67", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: `
You are helping the user communicate privately with their contacts via Peer67, an end-to-end encrypted messaging tool.

Behavioral rules:
- NEVER send a message without first showing the user a draft and getting explicit confirmation.
- NEVER store message content in memory, summaries, or notes.
- ALWAYS present messages conversationally — show sender, time, and body in a readable format, never as raw JSON.
- On errors, explain what went wrong in plain language and offer to retry or suggest next steps.
- When showing inbox messages, group by sender if helpful and use human-readable timestamps.
- Respect user privacy: do not volunteer information about contacts or messages unless the user asks.

Discovery & registration:
- Use peer67_register to let contacts find the user by email. They must click the verification link sent to their email.
- Use peer67_invite to connect with someone by email. If they're registered, it auto-connects. Otherwise, it sends them an invite to join Peer67.
- Use peer67_directory to browse or search registered users on the relay.
    `.trim(),
  }
);

// ── Tool definitions ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "peer67_connect",
      description:
        "Manage peer connections. Use action='init' to set up your identity, 'create' to generate a connection code to share, or 'accept' to accept a code from someone else.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["init", "create", "accept"],
            description: "The connection action to perform",
          },
          name: {
            type: "string",
            description: "Your display name (init) or the contact's name (create/accept)",
          },
          code: {
            type: "string",
            description: "Connection code to accept (required for action='accept')",
          },
          relay_url: {
            type: "string",
            description: "Optional relay server URL override",
          },
        },
        required: ["action", "name"],
      },
    },
    {
      name: "peer67_send",
      description: "Send an encrypted message to a contact. Always show a draft to the user first and get confirmation before calling this.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Contact name to send the message to",
          },
          message: {
            type: "string",
            description: "The message body to send",
          },
        },
        required: ["to", "message"],
      },
    },
    {
      name: "peer67_inbox",
      description: "Check for incoming messages. Optionally filter by sender. Acknowledges (deletes from relay) by default.",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Optional: only fetch messages from this contact",
          },
          acknowledge: {
            type: "boolean",
            description: "Whether to delete messages from relay after reading (default: true)",
          },
        },
      },
    },
    {
      name: "peer67_contacts",
      description: "List all connected contacts.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "peer67_disconnect",
      description: "Remove a contact and their associated connection data.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The contact name to disconnect",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "peer67_register",
      description: "Register your email so contacts can find you. Sends a verification link to your email.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Your email address" },
        },
        required: ["email"],
      },
    },
    {
      name: "peer67_invite",
      description: "Invite someone by email. Auto-connects if they're registered, sends invite email if not.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Email of person to invite" },
        },
        required: ["email"],
      },
    },
    {
      name: "peer67_directory",
      description: "List registered users on the relay, optionally search by name.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", description: "Optional search query to filter by name" },
        },
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const params = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "peer67_connect": {
        const action = params.action as string;
        const contactName = params.name as string;
        const code = params.code as string | undefined;
        const relayUrl = params.relay_url as string | undefined;

        if (action === "init") {
          await store.init(contactName);
          return text(
            `Identity set up as "${contactName}". Your Peer67 store is ready at ${storeDir}.\n` +
              `Next: use peer67_connect with action='create' to generate a connection code to share with someone, ` +
              `or action='accept' to accept a code they shared with you.`
          );
        }

        if (action === "create") {
          const result = await connectCreate(store, contactName, relayUrl);
          return text(
            `Connection code for ${contactName}:\n\n${result.code}\n\n` +
              `Share this code with ${contactName}. Once they accept it, the connection will complete automatically.`
          );
        }

        if (action === "accept") {
          if (!code) {
            return text("A connection code is required for action='accept'. Please provide the 'code' parameter.");
          }
          const result = await connectAccept(store, contactName, code);
          return text(
            result.message +
              `\nOnce ${contactName} completes their side, you'll be able to exchange messages.`
          );
        }

        return text(`Unknown action "${action}". Use 'init', 'create', or 'accept'.`);
      }

      case "peer67_send": {
        const to = params.to as string;
        const message = params.message as string;

        const result = await sendMessage(store, to, message);
        return text(
          `Message sent to ${to}. It will be available until ${new Date(result.expires_at).toLocaleString()}.`
        );
      }

      case "peer67_inbox": {
        const from = params.from as string | undefined;
        const acknowledge = params.acknowledge !== false; // default true

        const messages = await checkInbox(store, from);

        if (messages.length === 0) {
          const scope = from ? `from ${from}` : "from any contact";
          return text(`No new messages ${scope}.`);
        }

        const formatted = messages
          .map((msg) => {
            const when = timeAgo(new Date(msg.timestamp));
            return `[${msg.from} — ${when}]\n${msg.body}`;
          })
          .join("\n\n---\n\n");

        if (acknowledge) {
          await acknowledgeMessages(messages);
        }

        const suffix = acknowledge
          ? `\n\n(${messages.length} message${messages.length === 1 ? "" : "s"} acknowledged)`
          : `\n\n(${messages.length} message${messages.length === 1 ? "" : "s"} — not acknowledged)`;

        return text(formatted + suffix);
      }

      case "peer67_contacts": {
        const contacts = await listContacts(store);

        if (contacts.length === 0) {
          return text(
            "No contacts yet. Use peer67_connect with action='create' to invite someone, " +
              "or action='accept' to accept their invitation."
          );
        }

        const lines = contacts.map((c) => {
          const since = c.connected_at ? timeAgo(new Date(c.connected_at)) : "unknown";
          return `• ${c.display_name} (connected ${since}) — relay: ${c.relay_url}`;
        });

        return text(`Your contacts (${contacts.length}):\n\n${lines.join("\n")}`);
      }

      case "peer67_disconnect": {
        const contactName = params.name as string;
        await disconnectContact(store, contactName);
        return text(
          `Disconnected from ${contactName}. Their connection data has been removed from your local store.`
        );
      }

      case "peer67_register": {
        const email = params.email as string;
        const { email_hash, message } = await registerEmail(store, email);

        pollVerification(store, email_hash, 60, 5000).then(async (verified) => {
          if (verified) {
            await store.updateIdentity({ email });
            // Check for pending invites now that we're verified
            const data = await store.load();
            const pendingInvites = data.pending_invites ?? [];
            for (const invite of pendingInvites) {
              try {
                const config = await store.getConfig();
                const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
                const relay = new RelayClient(relayUrl);
                const lookup = await relay.lookup(invite.email_hash);
                if (lookup?.found && lookup.pub) {
                  await connectAutoInitiate(store, invite.email, lookup.pub, relayUrl);
                  await store.removePendingInvite(invite.email_hash);
                }
              } catch {
                // Silently skip errors during background invite resolution
              }
            }
          }
        }).catch(() => {
          // Polling errors are silent
        });

        return text(
          `${message}\n\nVerification email sent to ${email}. Once you click the link, ` +
            `your email will be confirmed and contacts can find you by address.`
        );
      }

      case "peer67_invite": {
        const email = params.email as string;
        const result = await inviteByEmail(store, email);
        return text(result.message);
      }

      case "peer67_directory": {
        const search = params.search as string | undefined;
        const config = await store.getConfig();
        const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
        const relay = new RelayClient(relayUrl);
        const users = await relay.directory(search);

        if (users.length === 0) {
          const scope = search ? ` matching "${search}"` : "";
          return text(`No registered users${scope} found on the relay.`);
        }

        const lines = users.map((u) => `• ${u.handle}`);
        const header = search
          ? `Users matching "${search}" (${users.length}):`
          : `Registered users (${users.length}):`;

        return text(`${header}\n\n${lines.join("\n")}`);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return text(`Error: ${message}\n\nYou can try again or check your connection and store configuration.`);
  }
});

// ── Background polling ─────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10_000;

async function pollCycle(): Promise<void> {
  try {
    // 1. Check if any pending outbound connection handshakes are complete
    const completedName = await connectComplete(store);
    if (completedName) {
      await server.notification({
        method: "notifications/message",
        params: {
          level: "info",
          message: `Connection with ${completedName} is now complete! You can start messaging them.`,
        },
      });
    }
  } catch {
    // Polling errors are silent — don't crash the server
  }

  try {
    // 2. Check for incoming auto-connect requests
    const incomingHandle = await checkConnectInbox(store);
    if (incomingHandle) {
      await server.notification({
        method: "notifications/message",
        params: {
          level: "info",
          message: `${incomingHandle} has connected with you! You can now exchange messages.`,
        },
      });
    }
  } catch {
    // Polling errors are silent
  }

  try {
    // 3. Check pending invites — auto-connect if they have now registered
    const data = await store.load();
    const pendingInvites = data.pending_invites ?? [];

    for (const invite of pendingInvites) {
      try {
        const config = await store.getConfig();
        const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
        const relay = new RelayClient(relayUrl);
        const lookup = await relay.lookup(invite.email_hash);

        if (lookup?.found && lookup.pub) {
          await connectAutoInitiate(store, invite.email, lookup.pub, relayUrl);
          await store.removePendingInvite(invite.email_hash);

          await server.notification({
            method: "notifications/message",
            params: {
              level: "info",
              message: `${invite.email} has joined Peer67! Connection initiated automatically.`,
            },
          });
        }
      } catch {
        // Silently skip errors for individual invite lookups
      }
    }
  } catch {
    // Polling errors are silent
  }
}

// ── CLI mode ──────────────────────────────────────────────────────────────
// When run with arguments, acts as a CLI. Without arguments, runs as MCP server.

async function cli(args: string[]): Promise<void> {
  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "setup": {
      const { setup } = await import("./setup.js");
      await setup();
      break;
    }
    case "init": {
      const name = rest[0];
      if (!name) { console.log("Usage: peer67 init <name>"); process.exit(1); }
      await store.init(name);
      console.log(`Initialized as "${name}". Store: ${storeDir}`);
      break;
    }
    case "connect": {
      const name = rest[0];
      if (!name) { console.log("Usage: peer67 connect <name>"); process.exit(1); }
      const { code, message } = await connectCreate(store, name);
      console.log(`\nConnection code for ${name}:\n\n  ${code}\n\n${message}`);
      break;
    }
    case "accept": {
      const name = rest[0];
      const code = rest[1];
      if (!name || !code) { console.log("Usage: peer67 accept <name> <code>"); process.exit(1); }
      const result = await connectAccept(store, name, code);
      console.log(result.message);
      break;
    }
    case "complete": {
      const name = await connectComplete(store);
      console.log(name ? `Connected with ${name}!` : "No pending connections completed yet.");
      break;
    }
    case "send": {
      const to = rest[0];
      const msg = rest.slice(1).join(" ");
      if (!to || !msg) { console.log("Usage: peer67 send <name> <message>"); process.exit(1); }
      const result = await sendMessage(store, to, msg);
      console.log(`Sent to ${to}. Expires: ${result.expires_at}`);
      break;
    }
    case "inbox": {
      const from = rest[0] || undefined;
      const messages = await checkInbox(store, from);
      if (messages.length === 0) { console.log("No new messages."); break; }
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
      if (contacts.length === 0) { console.log("No contacts."); break; }
      for (const c of contacts) console.log(`  ${c.display_name} (${c.relay_url})`);
      break;
    }
    case "register": {
      const email = rest[0];
      if (!email) { console.log("Usage: peer67 register <email>"); process.exit(1); }
      const { email_hash, message } = await registerEmail(store, email);
      console.log(message);
      console.log("Waiting for verification (up to 4 minutes)...");
      const verified = await pollVerification(store, email_hash, 120, 2000);
      if (verified) {
        await store.updateIdentity({ email });
        console.log(`Email verified! You are now registered as ${email}.`);
      } else {
        console.log("Verification timed out. Click the link in your email and run again.");
      }
      break;
    }
    case "invite": {
      const email = rest[0];
      if (!email) { console.log("Usage: peer67 invite <email>"); process.exit(1); }
      const result = await inviteByEmail(store, email);
      console.log(result.message);
      break;
    }
    case "directory": {
      const search = rest[0] || undefined;
      const config = await store.getConfig();
      const relayUrl = process.env.PEER67_RELAY ?? config.default_relay;
      const relay = new RelayClient(relayUrl);
      const users = await relay.directory(search);
      if (users.length === 0) {
        console.log(search ? `No users found matching "${search}".` : "No registered users.");
        break;
      }
      for (const u of users) console.log(`  ${u.handle}`);
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
      console.log("peer67 — encrypted ephemeral messaging\n");
      console.log("Commands:");
      console.log("  peer67 setup                    First-time setup (identity + Claude config)");
      console.log("  peer67 init <name>              Set up identity only");
      console.log("  peer67 register <email>         Register email for discovery");
      console.log("  peer67 invite <email>           Invite someone by email");
      console.log("  peer67 directory [search]       List registered users");
      console.log("  peer67 connect <name>           Generate connection code");
      console.log("  peer67 accept <name> <code>     Accept a connection code");
      console.log("  peer67 complete                 Check if pending connection completed");
      console.log("  peer67 send <name> <message>    Send encrypted message");
      console.log("  peer67 inbox [name]             Check messages");
      console.log("  peer67 contacts                 List connections");
      console.log("  peer67 status                   Show identity & connections");
      console.log("\nAs MCP server (no args):  runs as Claude Code MCP subprocess");
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);

if (cliArgs.length > 0) {
  cli(cliArgs).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  // MCP server mode
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    const pollInterval = setInterval(() => {
      void pollCycle();
    }, POLL_INTERVAL_MS);

    process.on("SIGINT", () => {
      clearInterval(pollInterval);
      process.exit(0);
    });
  }).catch((err: unknown) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
