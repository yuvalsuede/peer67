import basex from "base-x";
import { randomBytes } from "@noble/ciphers/webcrypto";

const BASE62 = basex(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
);
const PREFIX = "p67_";

const PUBLIC_KEY_BYTES = 32;
const URL_LENGTH_BYTES = 2;
const NONCE_BYTES = 16;
const MIN_WIRE_BYTES = PUBLIC_KEY_BYTES + URL_LENGTH_BYTES + NONCE_BYTES;

export interface DecodedConnectionCode {
  publicKey: Uint8Array; // 32 bytes
  relayUrl: string;
  nonce: Uint8Array; // 16 bytes
}

/**
 * Encodes an X25519 public key and relay URL into a p67_ connection code.
 *
 * Wire format:
 *   [32 bytes] X25519 public key
 *   [2 bytes]  relay URL length (big-endian uint16)
 *   [N bytes]  relay URL (UTF-8)
 *   [16 bytes] random nonce
 */
export function encodeConnectionCode(
  publicKey: Uint8Array,
  relayUrl: string
): string {
  const urlBytes = new TextEncoder().encode(relayUrl);
  const urlLength = urlBytes.length;

  const wire = new Uint8Array(
    PUBLIC_KEY_BYTES + URL_LENGTH_BYTES + urlLength + NONCE_BYTES
  );

  let offset = 0;

  wire.set(publicKey, offset);
  offset += PUBLIC_KEY_BYTES;

  wire[offset] = (urlLength >> 8) & 0xff;
  wire[offset + 1] = urlLength & 0xff;
  offset += URL_LENGTH_BYTES;

  wire.set(urlBytes, offset);
  offset += urlLength;

  wire.set(randomBytes(NONCE_BYTES), offset);

  return PREFIX + BASE62.encode(wire);
}

/**
 * Decodes a p67_ connection code back into its components.
 *
 * Throws "Invalid connection code" if the code is malformed.
 */
export function decodeConnectionCode(code: string): DecodedConnectionCode {
  if (!code.startsWith(PREFIX)) {
    throw new Error("Invalid connection code");
  }

  let wire: Uint8Array;
  try {
    wire = BASE62.decode(code.slice(PREFIX.length));
  } catch {
    throw new Error("Invalid connection code");
  }

  if (wire.length < MIN_WIRE_BYTES) {
    throw new Error("Invalid connection code");
  }

  let offset = 0;

  const publicKey = wire.slice(offset, offset + PUBLIC_KEY_BYTES);
  offset += PUBLIC_KEY_BYTES;

  const urlLength = (wire[offset] << 8) | wire[offset + 1];
  offset += URL_LENGTH_BYTES;

  if (wire.length < PUBLIC_KEY_BYTES + URL_LENGTH_BYTES + urlLength + NONCE_BYTES) {
    throw new Error("Invalid connection code");
  }

  const relayUrl = new TextDecoder().decode(
    wire.slice(offset, offset + urlLength)
  );
  offset += urlLength;

  const nonce = wire.slice(offset, offset + NONCE_BYTES);

  return { publicKey, relayUrl, nonce };
}
