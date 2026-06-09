/**
 * Team-mode crypto.
 *
 * Model: one random 32-byte shared_vault_key encrypts every credential
 * (exactly like personal mode's vault key). Each user keeps their own
 * copy of that shared key, sealed with a key-encrypting key (KEK)
 * derived from their password via argon2id.
 *
 *   password --argon2id--> user_kek
 *   shared_vault_key --AES-256-GCM(user_kek)--> stored per user
 *
 * Any member can therefore decrypt credentials after logging in, but
 * every user authenticates separately so actions are attributable in
 * the audit log. Adding a user = seal the shared key to their KEK.
 * Re-provisioning a user = seal a fresh copy to a new password's KEK.
 *
 * This reuses the same AES-256-GCM + argon2id primitives as vault.ts so
 * there is exactly one cryptographic implementation in the codebase.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  generateKdfParams,
  deriveVaultKey,
  computeVerifier,
  type KdfParams,
} from "./vault.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Generate a fresh random shared vault key (32 bytes). */
export function generateSharedKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Seal a binary key (e.g. the shared vault key) with a KEK.
 * Mirrors vault.ts encrypt() but operates on raw bytes instead of a
 * utf-8 string, since we're wrapping a key, not text.
 */
export function sealKey(
  key: Buffer,
  kek: Buffer,
): { nonce: Buffer; blob: Buffer } {
  const nonce = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const encrypted = Buffer.concat([cipher.update(key), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, blob: Buffer.concat([encrypted, tag]) };
}

/** Open a sealed binary key with the KEK. Throws if the KEK is wrong. */
export function openKey(blob: Buffer, nonce: Buffer, kek: Buffer): Buffer {
  const ciphertext = blob.subarray(0, -TAG_BYTES);
  const tag = blob.subarray(-TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Everything needed to persist a new (or re-provisioned) team user:
 * their KDF params, a password verifier, and the shared key sealed to
 * the KEK derived from their password.
 */
export interface ProvisionedUser {
  kdf: KdfParams;
  verifier: Buffer;
  sharedKeyNonce: Buffer;
  sharedKeyBlob: Buffer;
}

/**
 * Derive a user's KEK from their password and seal the shared vault key
 * to it. Used when an admin creates or re-provisions a user. The caller
 * must already hold the shared key in plaintext (an admin's unlocked
 * session does).
 */
export async function provisionUser(
  password: string,
  sharedKey: Buffer,
): Promise<ProvisionedUser> {
  const kdf = generateKdfParams();
  const kek = await deriveVaultKey(password, kdf);
  const verifier = computeVerifier(kek);
  const { nonce, blob } = sealKey(sharedKey, kek);
  return { kdf, verifier, sharedKeyNonce: nonce, sharedKeyBlob: blob };
}

/**
 * Verify a user's password and, on success, return the unsealed shared
 * vault key. Returns null if the password is wrong. Used on login.
 */
export async function unlockSharedKey(
  password: string,
  kdf: KdfParams,
  expectedVerifier: Buffer,
  sharedKeyBlob: Buffer,
  sharedKeyNonce: Buffer,
): Promise<Buffer | null> {
  const kek = await deriveVaultKey(password, kdf);
  const verifier = computeVerifier(kek);
  if (!verifier.equals(expectedVerifier)) {
    kek.fill(0);
    return null;
  }
  try {
    return openKey(sharedKeyBlob, sharedKeyNonce, kek);
  } finally {
    kek.fill(0);
  }
}
