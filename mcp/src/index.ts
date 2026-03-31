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
import { connectCreate, connectAccept, connectComplete } from "./tools/connect.js";
import { sendMessage } from "./tools/send.js";
import { checkInbox, acknowledgeMessages } from "./tools/inbox.js";
import { listContacts, disconnectContact } from "./tools/contacts.js";

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

async function pollConnections(): Promise<void> {
  try {
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
}

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const pollInterval = setInterval(() => {
    void pollConnections();
  }, POLL_INTERVAL_MS);

  process.on("SIGINT", () => {
    clearInterval(pollInterval);
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
