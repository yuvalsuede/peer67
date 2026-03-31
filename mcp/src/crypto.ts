import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";

export interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateKeypair(): Keypair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  return x25519.getSharedSecret(myPrivateKey, theirPublicKey);
}

export function deriveMailboxIds(sharedSecret: Uint8Array): {
  mailboxAtoB: Uint8Array;
  mailboxBtoA: Uint8Array;
} {
  const mailboxAtoB = hkdf(
    sha256,
    sharedSecret,
    undefined,
    "peer67-mailbox-a2b",
    32
  );
  const mailboxBtoA = hkdf(
    sha256,
    sharedSecret,
    undefined,
    "peer67-mailbox-b2a",
    32
  );
  return { mailboxAtoB, mailboxBtoA };
}

export function deriveEncryptKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, "peer67-encrypt", 32);
}

export function encrypt(
  key: Uint8Array,
  plaintext: string,
  mailboxIdHex: string
): string {
  const nonce = randomBytes(12);
  const aad = new TextEncoder().encode(mailboxIdHex);
  const plaintextBytes = new TextEncoder().encode(plaintext);

  const cipher = gcm(key, nonce, aad);
  const ciphertext = cipher.encrypt(plaintextBytes);

  // Wire format: nonce (12) + ciphertext (includes auth tag appended by noble)
  const wire = new Uint8Array(12 + ciphertext.length);
  wire.set(nonce, 0);
  wire.set(ciphertext, 12);

  return Buffer.from(wire).toString("base64");
}

export function decrypt(
  key: Uint8Array,
  ciphertextB64: string,
  mailboxIdHex: string
): string {
  const wire = Buffer.from(ciphertextB64, "base64");
  const nonce = wire.subarray(0, 12);
  const ciphertext = wire.subarray(12);
  const aad = new TextEncoder().encode(mailboxIdHex);

  const cipher = gcm(key, nonce, aad);
  const plaintext = cipher.decrypt(ciphertext);

  return new TextDecoder().decode(plaintext);
}
