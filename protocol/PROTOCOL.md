# Peer67 Protocol v1

## Overview

Peer67 is an anonymous, ephemeral messaging protocol. Two parties establish a connection via a one-time code exchange, then send encrypted messages through a relay server that has zero knowledge of the participants.

## Relay API

### Messaging endpoints

| Method | Path | Description |
|--------|------|-------------|
| `PUT /d/{mailbox_id}` | Store a blob. Body: `{ "blob": "<base64>" }`. Returns `{ "id": "<nanoid>", "expires_at": "<ISO>" }`. |
| `GET /d/{mailbox_id}?after={unix_ts}` | Fetch blobs. Returns `{ "blobs": [{ "id", "blob", "ts" }] }`. |
| `DELETE /d/{mailbox_id}/{blob_id}` | Delete a blob. Returns `{ "ok": true }`. |

Constraints:
- `mailbox_id`: 64-character lowercase hex string (256-bit)
- Max blob size: 64 KB (base64-encoded)
- Max blobs per mailbox: 1000
- All blobs auto-expire after 86400 seconds (24 hours)
- No authentication required

### Discovery endpoints

The discovery layer is optional. Users register an email to become findable; connections can be initiated by email without manual code exchange.

| Method | Path | Description |
|--------|------|-------------|
| `POST /r/register` | Register email for discovery. Body: `{ "email_hash": "<sha256-hex>", "pub": "<base64-pubkey>", "handle": "<display-name>" }`. Sends a verification email. Returns `{ "ok": true }`. |
| `GET /r/verify/{token}` | Click-through link in verification email. Marks the registration as verified. |
| `GET /r/poll/{email_hash}` | Poll for verification status. Returns `{ "verified": true/false }`. |
| `GET /r/lookup/{email_hash}` | Look up a registered user by email hash. Returns `{ "found": true, "pub": "<base64>", "handle": "<name>" }` or `{ "found": false }`. |
| `GET /r/directory` | List registered users. Query param: `?q=<search>`. Returns `[{ "handle": "<name>" }]`. |

The relay stores email addresses only as SHA-256 hashes. The plaintext email is never transmitted to the relay.

### SSE push endpoint

| Method | Path | Description |
|--------|------|-------------|
| `GET /subscribe` | Subscribe to real-time blob events. Query param: `?ids=<comma-separated-mailbox-ids>`. Returns an SSE stream. |

SSE events:

```
event: blob
data: {"mailbox_id":"<hex>"}
```

When a `blob` event arrives, the MCP server immediately polls `GET /d/{mailbox_id}` for new messages. This provides ~100ms end-to-end latency. On SSE disconnect, the MCP server falls back to polling every 5 seconds until the SSE connection is restored.

## Connection Protocol

### Step 1: Initiator creates a code

1. Generate X25519 keypair `(sk_a, pk_a)`
2. Encode connection code: `p67_` + base62 of `pk_a (32B) || url_len (2B big-endian) || relay_url (NB UTF-8) || nonce (16B random)`
3. Share code out-of-band

### Step 2: Acceptor processes the code

1. Decode `pk_a`, `relay_url` from code
2. Generate X25519 keypair `(sk_b, pk_b)`
3. Compute `shared = X25519(sk_b, pk_a)`
4. Derive via HKDF-SHA256 (no salt):
   - `mailbox_a2b = HKDF(shared, info="peer67-mailbox-a2b", len=32)`
   - `mailbox_b2a = HKDF(shared, info="peer67-mailbox-b2a", len=32)`
   - `encrypt_key = HKDF(shared, info="peer67-encrypt", len=32)`
5. Store connection locally
6. Compute rendezvous mailbox: `SHA256(pk_a)` as hex
7. PUT `pk_b` (base64) to rendezvous mailbox on relay

### Step 3: Initiator completes

1. Compute rendezvous mailbox: `SHA256(pk_a)` as hex
2. Poll relay for blobs at rendezvous mailbox
3. When found: decode `pk_b`, compute `shared = X25519(sk_a, pk_b)`
4. Derive same `mailbox_a2b`, `mailbox_b2a`, `encrypt_key`
5. Store connection locally
6. DELETE the handshake blob from rendezvous mailbox

### Roles

- **Initiator (A)**: writes to `mailbox_a2b`, reads from `mailbox_b2a`
- **Acceptor (B)**: writes to `mailbox_b2a`, reads from `mailbox_a2b`

### Auto-connect via discovery

When both parties are registered in the discovery layer, connections are initiated automatically:

1. Alice calls `POST /r/invite` with Bob's email hash
2. Relay looks up Bob's public key via `GET /r/lookup/{email_hash}`
3. If Bob is registered: Alice's MCP server calls `connectAutoInitiate`, which performs Step 1 above using Bob's registered public key
4. Bob's MCP server detects the incoming connection via `checkConnectInbox` (polling `GET /d/{sha256(bob_pk)}`)
5. The connection completes without any manual code exchange

If Bob is not yet registered, the invite is stored as a pending invite. On the next poll cycle, the MCP server retries the lookup. Once Bob registers, the connection initiates automatically.

## Message Format

Plaintext envelope:
```json
{ "v": 1, "t": <unix_seconds>, "b": "<message body>" }
```

Encryption:
- Algorithm: AES-256-GCM
- Key: `encrypt_key` (32 bytes from HKDF)
- Nonce: 12 random bytes
- AAD: mailbox_id (hex string, UTF-8 encoded)

Wire format (base64 of):
```
[12B nonce] [NB ciphertext + 16B GCM auth tag]
```

The blob sent to the relay is the base64 encoding of this wire format.

## Profile Support

A profile is a named, isolated identity. Each profile has:

- Its own store directory: `~/.peer67-<profile-name>/`
- Its own X25519 keypair and connections
- Its own MCP server entry in `~/.claude/settings.json` under key `peer67-<profile-name>`
- The MCP server sets `PEER67_DIR` env var to point to the profile's store directory

The default profile uses `~/.peer67/` and the MCP key `peer67`.

Create a new profile:
```bash
peer67 setup --profile <name>
```

## Security Properties

- The relay never learns participant identities
- Separate mailbox IDs per direction prevent correlation
- AAD binding prevents cross-mailbox replay
- 24h TTL ensures forward secrecy of metadata
- X25519 provides authenticated key exchange (assuming trusted code delivery)
- Email addresses are stored only as SHA-256 hashes in the discovery layer
