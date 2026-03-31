# Peer67 Protocol v1

## Overview

Peer67 is an anonymous, ephemeral messaging protocol. Two parties establish a connection via a one-time code exchange, then send encrypted messages through a relay server that has zero knowledge of the participants.

## Relay API

A Peer67 relay exposes three endpoints:

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

## Security Properties

- The relay never learns participant identities
- Separate mailbox IDs per direction prevent correlation
- AAD binding prevents cross-mailbox replay
- 24h TTL ensures forward secrecy of metadata
- X25519 provides authenticated key exchange (assuming trusted code delivery)
