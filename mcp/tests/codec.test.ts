import { describe, it, expect } from "vitest";
import { encodeConnectionCode, decodeConnectionCode } from "../src/codec.js";
import { generateKeypair } from "../src/crypto.js";

describe("encodeConnectionCode / decodeConnectionCode", () => {
  it("round-trips a connection code (same public key + relay URL)", () => {
    const { publicKey } = generateKeypair();
    const relayUrl = "https://relay.peer67.com";

    const code = encodeConnectionCode(publicKey, relayUrl);
    const decoded = decodeConnectionCode(code);

    expect(decoded.publicKey).toEqual(publicKey);
    expect(decoded.relayUrl).toBe(relayUrl);
    expect(decoded.nonce).toHaveLength(16);
  });

  it("handles long relay URLs", () => {
    const { publicKey } = generateKeypair();
    const relayUrl =
      "https://relay.very-long-domain-name.example.com:8443/peer67/relay/v2/endpoint?token=abc123&region=us-east-1";

    const code = encodeConnectionCode(publicKey, relayUrl);
    const decoded = decodeConnectionCode(code);

    expect(decoded.publicKey).toEqual(publicKey);
    expect(decoded.relayUrl).toBe(relayUrl);
  });

  it("rejects codes without p67_ prefix", () => {
    const { publicKey } = generateKeypair();
    const code = encodeConnectionCode(publicKey, "https://relay.peer67.com");
    const stripped = code.slice("p67_".length); // remove prefix

    expect(() => decodeConnectionCode(stripped)).toThrow("Invalid connection code");
  });

  it("rejects truncated codes", () => {
    const { publicKey } = generateKeypair();
    const code = encodeConnectionCode(publicKey, "https://relay.peer67.com");
    const truncated = code.slice(0, code.length - 10);

    expect(() => decodeConnectionCode(truncated)).toThrow("Invalid connection code");
  });

  it("produces different codes each time (random nonce)", () => {
    const { publicKey } = generateKeypair();
    const relayUrl = "https://relay.peer67.com";

    const code1 = encodeConnectionCode(publicKey, relayUrl);
    const code2 = encodeConnectionCode(publicKey, relayUrl);

    expect(code1).not.toBe(code2);
  });
});
