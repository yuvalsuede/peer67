import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  deriveSharedSecret,
  deriveMailboxIds,
  deriveEncryptKey,
  encrypt,
  decrypt,
} from "../src/crypto.js";

describe("generateKeypair", () => {
  it("produces 32-byte private and public keys", () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it("generates unique keypairs each call", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(kp1.privateKey).not.toEqual(kp2.privateKey);
    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });
});

describe("deriveSharedSecret", () => {
  it("produces the same shared secret from both sides", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secretAlice = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const secretBob = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(secretAlice).toEqual(secretBob);
  });

  it("produces a 32-byte shared secret", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.length).toBe(32);
  });
});

describe("deriveMailboxIds", () => {
  it("produces two distinct 32-byte mailbox IDs", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const { mailboxAtoB, mailboxBtoA } = deriveMailboxIds(secret);

    expect(mailboxAtoB).toBeInstanceOf(Uint8Array);
    expect(mailboxBtoA).toBeInstanceOf(Uint8Array);
    expect(mailboxAtoB.length).toBe(32);
    expect(mailboxBtoA.length).toBe(32);
    expect(mailboxAtoB).not.toEqual(mailboxBtoA);
  });

  it("produces deterministic mailbox IDs from same shared secret", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);

    const ids1 = deriveMailboxIds(secret);
    const ids2 = deriveMailboxIds(secret);
    expect(ids1.mailboxAtoB).toEqual(ids2.mailboxAtoB);
    expect(ids1.mailboxBtoA).toEqual(ids2.mailboxBtoA);
  });
});

describe("deriveEncryptKey", () => {
  it("produces a 32-byte encryption key", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const key = deriveEncryptKey(secret);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("produces a deterministic key from same shared secret", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const key1 = deriveEncryptKey(secret);
    const key2 = deriveEncryptKey(secret);
    expect(key1).toEqual(key2);
  });
});

describe("encrypt / decrypt", () => {
  const getFixtures = () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const key = deriveEncryptKey(secret);
    const { mailboxAtoB } = deriveMailboxIds(secret);
    const mailboxIdHex = Buffer.from(mailboxAtoB).toString("hex");
    return { key, mailboxIdHex };
  };

  it("round-trips plaintext", () => {
    const { key, mailboxIdHex } = getFixtures();
    const plaintext = "Hello, Peer67!";
    const ciphertext = encrypt(key, plaintext, mailboxIdHex);
    const decrypted = decrypt(key, ciphertext, mailboxIdHex);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips empty string", () => {
    const { key, mailboxIdHex } = getFixtures();
    const ciphertext = encrypt(key, "", mailboxIdHex);
    const decrypted = decrypt(key, ciphertext, mailboxIdHex);
    expect(decrypted).toBe("");
  });

  it("round-trips unicode text", () => {
    const { key, mailboxIdHex } = getFixtures();
    const plaintext = "Hello 🌍 Мир 世界";
    const ciphertext = encrypt(key, plaintext, mailboxIdHex);
    const decrypted = decrypt(key, ciphertext, mailboxIdHex);
    expect(decrypted).toBe(plaintext);
  });

  it("returns different ciphertext for same plaintext (random nonce)", () => {
    const { key, mailboxIdHex } = getFixtures();
    const plaintext = "same message";
    const ct1 = encrypt(key, plaintext, mailboxIdHex);
    const ct2 = encrypt(key, plaintext, mailboxIdHex);
    expect(ct1).not.toBe(ct2);
  });

  it("throws when decrypting with wrong key", () => {
    const { key, mailboxIdHex } = getFixtures();
    const { key: wrongKey } = getFixtures();
    const ciphertext = encrypt(key, "secret", mailboxIdHex);
    expect(() => decrypt(wrongKey, ciphertext, mailboxIdHex)).toThrow();
  });

  it("throws when decrypting with wrong AAD (mailbox ID)", () => {
    const { key, mailboxIdHex } = getFixtures();
    const ciphertext = encrypt(key, "secret", mailboxIdHex);
    const wrongMailboxId = "deadbeef".repeat(8); // 64 hex chars = 32 bytes
    expect(() => decrypt(key, ciphertext, wrongMailboxId)).toThrow();
  });

  it("returns base64 string", () => {
    const { key, mailboxIdHex } = getFixtures();
    const ciphertext = encrypt(key, "test", mailboxIdHex);
    expect(typeof ciphertext).toBe("string");
    // Should be valid base64
    expect(() => Buffer.from(ciphertext, "base64")).not.toThrow();
    // Wire format: 12 (nonce) + plaintext bytes + 16 (auth tag) minimum
    const decoded = Buffer.from(ciphertext, "base64");
    expect(decoded.length).toBeGreaterThanOrEqual(12 + 16);
  });
});
