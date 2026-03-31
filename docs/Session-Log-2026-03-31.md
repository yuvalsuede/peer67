# Peer67 v2 — Session Log 2026-03-31

## What Was Built

### Architecture (complete rewrite from v1)
- **v1**: Centralized relay with users, accounts, Supabase, OTP, email invites
- **v2**: Anonymous dead-drop relay, zero metadata, ephemeral 24h TTL, no accounts

### Components Built
| Component | Files | Tests |
|-----------|-------|-------|
| Relay (Fastify + Redis) | 3 source files | 25 tests |
| MCP Server (Claude skill) | 8 source files | 41 tests |
| **Total** | **11 source** | **66 tests passing** |

### Relay (`relay/`)
- `src/store.ts` — Redis blob store (put/get/del, 64KB max, 1000/mailbox, 24h TTL)
- `src/index.ts` — Fastify server: PUT/GET/DELETE `/d/:mailboxId` + `/health`
- `src/middleware.ts` — Validation (mailbox ID format, base64)
- `Dockerfile` — Multi-stage build for production
- `docker-compose.yml` — Redis + relay for local dev

### MCP Server (`mcp/`)
- `src/crypto.ts` — X25519 key exchange, HKDF-SHA256 derivation, AES-256-GCM encrypt/decrypt
- `src/codec.ts` — Connection code encode/decode (`p67_` prefix, base62)
- `src/store.ts` — Local encrypted store at `~/.peer67/` (AES-256-GCM at rest)
- `src/relay-client.ts` — HTTP client for relay
- `src/tools/connect.ts` — Handshake: create code, accept code, complete via rendezvous mailbox
- `src/tools/send.ts` — Encrypt message + PUT to relay
- `src/tools/inbox.ts` — GET from relay + decrypt
- `src/tools/contacts.ts` — List/disconnect contacts
- `src/index.ts` — MCP server (tool handlers, polling) + CLI mode
- `src/setup.ts` — `peer67 setup` command: creates identity + registers MCP in Claude settings

### Published
- **npm**: `@peer67/mcp@0.1.1` (published, later 0.2.0 with setup command pending)
- **npm page**: https://www.npmjs.com/package/@peer67/mcp

### Protocol
- `protocol/PROTOCOL.md` — Formal spec (relay API, connection protocol, message format, security)
- `README.md` — Project overview, quick start, architecture, security model

## Crypto Design
- **Key exchange**: X25519 (ephemeral keypairs, no pre-shared secrets)
- **Key derivation**: HKDF-SHA256 with distinct info strings for mailbox IDs and encryption key
- **Encryption**: AES-256-GCM with mailbox ID as AAD (prevents replay across mailboxes)
- **Connection codes**: `p67_` + base62(public_key + relay_url + nonce)
- **Rendezvous mailbox**: SHA256(initiator's public key) — temporary meeting point for handshake
- **Two mailboxes per connection**: separate addresses for each direction (prevents relay correlation)

## Architecture Decisions (from 3 architect agents)

### Distribution (Architect 1)
- Single binary: CLI + MCP server in one package
- `peer67 setup` auto-registers in `~/.claude/settings.json`
- `PEER67_RELAY` env var for relay URL override
- Default relay: `relay.peer67.com` (not yet deployed)

### Two-User Testing (Architect 2)
- Project-level `.mcp.json` with different `PEER67_DIR` env vars
- Created `peer67-test-suede/` and `peer67-test-dana/` test directories
- No code changes needed — existing `PEER67_DIR` support is sufficient

### UX Design (Architect 3)
- Auto-init on first use (don't require explicit setup step in Claude)
- Short connection codes via relay `/invite` endpoint (future)
- Check inbox once on session start, then only when asked
- Typed error handling with conversational error messages
- README quick-start in 3 steps / 60 seconds

## Current State
- Relay running locally on `localhost:3967` (mock Redis, in-memory)
- Suede initialized, connection code generated for Dana
- MCP server registered in Claude Code settings
- npm package published but needs republish with setup command (0.2.0)

## Next Steps
1. Deploy relay to Railway with Redis
2. Republish `@peer67/mcp@0.2.0` with setup command
3. Test two-user messaging end-to-end via Claude sessions
4. Point `relay.peer67.com` DNS to Railway
5. Push to GitHub at `yuvalsuede/peer67`

## Git Log
```
fa185ee test(mcp): integration tests — full connect + send/receive flow
36f8412 docs: protocol specification v1
16cf332 docs: root README — overview, quick start, architecture, security
4653073 chore: Dockerfile + docker-compose for local relay dev
01bfbb9 feat(mcp): MCP server entry — tool handlers, polling, instructions
4f5f243 feat(relay): HTTP endpoints — PUT/GET/DELETE blobs + health
c90c3c7 feat(mcp): tool implementations — connect, send, inbox, contacts
a2b711f feat(mcp): connection code codec — p67_ prefix, base62
8443570 feat(relay): blob store with TTL, size limits, and mailbox cap
47faf58 feat(mcp): local encrypted store — ~/.peer67/ connections + config
66f635b feat(mcp): crypto module — X25519, HKDF, AES-256-GCM
8b0c459 feat(mcp): relay HTTP client — put, get, delete
0745b3a chore: scaffold peer67 v2 — relay + mcp packages
```
