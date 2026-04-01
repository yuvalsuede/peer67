---
name: peer67
description: Encrypted ephemeral messaging for Claude Code. Send and receive real-time messages through your AI agent. Use when the user wants to message someone, check messages, invite contacts, or chat.
homepage: https://peer67.com
---

## Install peer67 if it doesn't exist

```bash
npm install -g peer67
peer67 setup
```

npm release: https://www.npmjs.com/package/peer67
peer67 github: https://github.com/yuvalsuede/peer67
official website: https://peer67.com

---

| Property | Value |
|----------|-------|
| **name** | peer67 |
| **description** | End-to-end encrypted ephemeral messaging for Claude Code |
| **allowed-tools** | mcp__peer67__peer67_send, mcp__peer67__peer67_inbox, mcp__peer67__peer67_contacts, mcp__peer67__peer67_invite, mcp__peer67__peer67_connect, mcp__peer67__peer67_directory, mcp__peer67__peer67_requests, mcp__peer67__peer67_disconnect, mcp__peer67__peer67_register |

---

## Core Workflow

1. **Setup** — Install and create identity
2. **Connect** — Invite by email or share connection code
3. **Chat** — Send and receive encrypted messages in real-time
4. **Messages auto-delete** in 24 hours

```bash
# 1. Setup
npm install -g peer67
peer67 setup

# 2. Launch with real-time channels
claude --dangerously-load-development-channels server:peer67

# 3. In Claude Code
> /peer67:invite dana@example.com
> /peer67:chat Dana
> hey, are you free?
  Sent.
>> Dana (2s ago): "yeah, what's up?"
```

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/peer67:chat <name>` | Start a live chat session with a contact |
| `/peer67:send <name> <message>` | Send a single encrypted message |
| `/peer67:inbox` | Check for new messages |
| `/peer67:invite <email>` | Invite someone by email (auto-connects if registered) |
| `/peer67:contacts` | List all connected contacts |
| `/peer67:directory [search]` | Browse registered users on the relay |
| `/peer67:requests` | View, accept, or decline incoming connection requests |
| `/peer67:setup` | Set up identity (name + email registration) |

---

## Message Handling

- Messages from contacts arrive in real-time via Claude Code channels
- When the user says "tell X ..." or "message X ...", send immediately using `peer67_send`. No drafts, no confirmation.
- NEVER send code, tool output, or file contents as messages — only the user's natural language
- In chat mode (`/peer67:chat`), every user message is a message to that contact

---

## Connection Methods

### By email (recommended)
```
> /peer67:invite dana@example.com
# Auto-connects if they're registered, sends invite email if not
```

### By connection code (manual)
```bash
# Alice generates a code
peer67 connect Dana

# Bob accepts it
peer67 accept Alice <p67_...code>

# Alice completes
peer67 complete
```

---

## Security

- End-to-end encrypted: X25519 key exchange + AES-256-GCM
- Zero-knowledge relay: stores only encrypted blobs at hashed addresses
- No metadata: no users, no accounts, no sender/recipient fields, no logs
- Ephemeral: 24h auto-delete, no permanent storage
- AAD binding: ciphertext bound to destination mailbox, prevents replay

---

## Architecture

```
Human <-> Claude <-> peer67 MCP <-> Relay <-> peer67 MCP <-> Claude <-> Human
                     (encrypt)      (blob)     (decrypt)
```

- **MCP Server + Channel**: Claude Code subprocess, handles crypto + real-time push
- **Relay**: Stateless dead-drop, 24h TTL, zero knowledge
- **Protocol**: X25519 + HKDF-SHA256 + AES-256-GCM with AAD

---

## Links

- Website: https://peer67.com
- GitHub: https://github.com/yuvalsuede/peer67
- npm: https://www.npmjs.com/package/peer67
- Protocol: https://github.com/yuvalsuede/peer67/blob/main/protocol/PROTOCOL.md
- License: MIT
