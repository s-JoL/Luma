import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Store } from "../store/store.ts";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * Reads, or creates on first run, the 32-byte key that protects every stored
 * credential. Keeping it outside the database means a copied `luma.sqlite`
 * is useless on its own.
 */
export function loadMasterKey(file: string) {
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file);
    if (key.length === 32) return key;
    throw new Error(`Master key at ${file} must be exactly 32 bytes`);
  }
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export class SecretVault {
  constructor(
    private readonly store: Store,
    private readonly masterKey: Buffer,
  ) {}

  has(name: string) {
    return this.store.hasSecret(name);
  }

  names() {
    return this.store.listSecretNames();
  }

  get(name: string): string | undefined {
    const row = this.store.readSecretRow(name);
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, Buffer.from(row.iv));
      decipher.setAuthTag(Buffer.from(row.tag));
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
    } catch {
      // A key rotation or corrupt row must not take the server down; the
      // caller sees a missing credential and can re-enter it in Settings.
      return undefined;
    }
  }

  set(name: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      this.store.deleteSecret(name);
      return;
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
    this.store.writeSecretRow(name, iv, cipher.getAuthTag(), ciphertext);
  }

  delete(name: string) {
    this.store.deleteSecret(name);
  }
}

/**
 * Compared as digests rather than as bytes, so the answer takes the same time
 * for a candidate of any length. Comparing the strings meant returning early on
 * a length mismatch, which told a caller how long the stored secret was.
 */
export function constantTimeEquals(left: string, right: string) {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(left), digest(right));
}
