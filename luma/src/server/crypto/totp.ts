/**
 * RFC 6238 time-based one-time passwords, SHA-1 / 6 digits / 30 seconds — the
 * profile every authenticator app assumes. Implemented here rather than pulled
 * in as a dependency: it is thirty lines of HMAC, and an auth primitive is the
 * last place to add a supply chain.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** One step either side, so a clock a few seconds out still works. */
const DRIFT_STEPS = 1;

function base32Encode(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string) {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of input.replace(/=+$/, "").toUpperCase()) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

function code(secret: Buffer, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The time step a code matched, or null if none did. The step rather than a
 * boolean because RFC 6238 §5.2 asks that an accepted code be refused for the
 * rest of its validity window, and only the caller knows where to keep the
 * watermark that takes.
 */
export function verifyTotpStep(secret: string, candidate: string, now = Date.now()) {
  const cleaned = candidate.replace(/\D/g, "");
  if (cleaned.length !== DIGITS) return null;
  const key = base32Decode(secret);
  if (!key.length) return null;
  const supplied = Buffer.from(cleaned);
  const current = Math.floor(now / 1000 / PERIOD_SECONDS);
  let matched: number | null = null;
  // Every step in the window is compared even once one has matched, so the
  // answer takes the same time whichever code was sent.
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    if (timingSafeEqual(Buffer.from(code(key, current + drift)), supplied)) matched = current + drift;
  }
  return matched;
}

/** The URI an authenticator app expects behind a QR code. */
export function otpauthUri(secret: string, account: string, issuer = "Luma") {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
