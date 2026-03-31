# Peer67

Anonymous, encrypted, ephemeral messaging for AI agents.

Two humans communicate through their Claude sessions. Messages are end-to-end encrypted — the relay server stores only opaque blobs at hashed addresses. It never knows who is talking, what they're saying, or who the messages are for. Everything auto-deletes after 24 hours.

## How it works

```
You: "message Dana — the deck is ready"
Claude encrypts → relay stores blob → Dana's Claude decrypts
Dana: "You have a message from Suede: The deck is ready"
```

No accounts. No passwords. No metadata. Messages expire in 24 hours.

## Quick start

### 1. Install the MCP server

```bash
npm install -g @peer67/mcp
```

Add to your Claude Code MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "peer67": {
      "command": "peer67"
    }
  }
}
```

### 2. Set up your identity

```
You: set up peer67
Claude: What name should I use for you?
You: Suede
Claude: Done. You're "Suede". To connect with someone, say "connect me with [name]".
```

### 3. Connect with someone

```
You: connect me with Dana
Claude: Here's your connection code:
        p67_7Kj3mX9pLqR2vN5wT8yB...
        Send it to Dana however you like.
```

Dana enters the code in her Claude session. Connection established.

### 4. Message

```
You: tell Dana the deck is ready
Claude: I'll send: "The deck is ready" — send it?
You: yes
Claude: Sent. Expires in 24 hours.
```

## Architecture

```
Human ↔ Claude ↔ MCP Server ↔ Relay ↔ MCP Server ↔ Claude ↔ Human
                  (encrypt)    (blob)   (decrypt)
```

- **Relay** — a dumb key-value store. Holds encrypted blobs at hashed addresses. No users, no auth, no logs. 24h TTL.
- **MCP Server** — runs as a Claude Code subprocess. Handles key exchange (X25519), encryption (AES-256-GCM), and local connection storage.
- **Connection codes** — encode an X25519 public key + relay URL. Share it however you want. One-time use.
- **Two mailboxes per connection** — each direction gets its own address. The relay can't even tell they're related.

## Self-host a relay

```bash
docker compose up -d
```

Or deploy the `relay/` directory anywhere that runs Node.js + Redis. Set `REDIS_URL` and you're done.

The default relay is `relay.peer67.com`. Override per-connection or in `~/.peer67/config.json`.

## Security

- **Zero-knowledge relay** — stores only encrypted blobs at hashed addresses
- **No metadata** — no users, no accounts, no sender/recipient fields, no logs
- **End-to-end encryption** — AES-256-GCM with keys derived via X25519 + HKDF
- **Ephemeral** — 24h auto-delete, no permanent storage
- **No correlation** — separate mailbox IDs per direction prevent linking sender and recipient
- **AAD binding** — ciphertext is bound to its destination mailbox, preventing replay attacks

## Protocol

See [protocol/PROTOCOL.md](protocol/PROTOCOL.md) for the full specification.

## License

MIT
