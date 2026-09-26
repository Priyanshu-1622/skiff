import { createHash } from "node:crypto";

/**
 * SSH host key helpers.
 *
 * ssh2 hands the host verifier the raw public key blob (RFC 4253 §6.6). The
 * fingerprint people can actually check — the one `ssh-keygen -lf` prints and
 * that `ssh` shows on first connect — is the unpadded base64 of its SHA-256.
 */

export function hostKeyFingerprint(rawKey: Buffer): string {
  return "SHA256:" + createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "");
}

/** The key type named inside the blob, e.g. "ssh-ed25519". */
export function hostKeyType(rawKey: Buffer): string {
  if (rawKey.length < 4) return "unknown";
  const len = rawKey.readUInt32BE(0);
  if (len <= 0 || len > 64 || rawKey.length < 4 + len) return "unknown";
  const type = rawKey.subarray(4, 4 + len).toString("ascii");
  return /^[a-z0-9@.-]+$/i.test(type) ? type : "unknown";
}

/**
 * What versions before 0.3.2 stored as the "fingerprint": the whole key in
 * base64 with a SHA256: prefix. Still recognised so hosts pinned by an older
 * Skiff keep connecting (and get migrated to the real fingerprint).
 */
export function legacyHostKeyId(rawKey: Buffer): string {
  return "SHA256:" + rawKey.toString("base64");
}
