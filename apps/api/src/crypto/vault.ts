/**
 * Vault cryptography — uses Node.js built-in crypto only.
 * No libsodium dependency (avoids ESM issues on Windows).
 *
 * KDF:        argon2id (master password → 32-byte vault key)
 * Encryption: AES-256-GCM (authenticated encryption, tamper-proof)
 * Verifier:   HMAC-SHA256(vault_key, "skiff-verifier-v1")
 */

import argon2 from "argon2";
import {
  randomBytes,
  createHmac,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const KDF_ITERATIONS = 3;
const KDF_MEMORY_KIB = 65536;
const KDF_PARALLELISM = 4;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;   // AES-GCM standard nonce
const TAG_BYTES = 16;  // AES-GCM auth tag

export interface KdfParams {
  algorithm: "argon2id";
  salt: Buffer;
  iterations: number;
  memoryKib: number;
  parallelism: number;
}

export function generateKdfParams(): KdfParams {
  return {
    algorithm: "argon2id",
    salt: randomBytes(SALT_BYTES),
    iterations: KDF_ITERATIONS,
    memoryKib: KDF_MEMORY_KIB,
    parallelism: KDF_PARALLELISM,
  };
}

export async function deriveVaultKey(
  password: string,
  params: KdfParams,
): Promise<Buffer> {
  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    salt: params.salt,
    timeCost: params.iterations,
    memoryCost: params.memoryKib,
    parallelism: params.parallelism,
    hashLength: KEY_BYTES,
    raw: true,
  });
  return hash;
}

export function computeVerifier(vaultKey: Buffer): Buffer {
  return Buffer.from(
    createHmac("sha256", vaultKey).update("skiff-verifier-v1").digest(),
  );
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns { nonce (IV), ciphertext (ciphertext + auth tag concatenated) }
 */
export function encrypt(
  plaintext: string,
  vaultKey: Buffer,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", vaultKey, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Store tag appended to ciphertext so the blob is self-contained
  return {
    nonce,
    ciphertext: Buffer.concat([encrypted, tag]),
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 */
export function decrypt(
  ciphertextWithTag: Buffer,
  nonce: Buffer,
  vaultKey: Buffer,
): string {
  const ciphertext = ciphertextWithTag.subarray(0, -TAG_BYTES);
  const tag = ciphertextWithTag.subarray(-TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", vaultKey, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
