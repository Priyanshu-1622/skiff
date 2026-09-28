import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { sealKey, openKey } from "./team-vault.js";

/**
 * Per-session data keys.
 *
 * Each SSH session gets its own random key. It is stored wrapped under the
 * vault (or team shared) key, and kept in memory for the life of the session.
 * That is what lets a session keep writing its recording (and, later, its
 * Memory entries) after the vault locks — the same exposure as the SSH
 * connection's own credentials, which also live in memory while it runs.
 */
export function newDataKey(): Buffer {
  return randomBytes(32);
}

export function wrapDataKey(dataKey: Buffer, vaultKey: Buffer): { nonce: Buffer; wrapped: Buffer } {
  const { nonce, blob } = sealKey(dataKey, vaultKey);
  return { nonce, wrapped: blob };
}

export function unwrapDataKey(wrapped: Buffer, nonce: Buffer, vaultKey: Buffer): Buffer {
  return openKey(wrapped, nonce, vaultKey);
}

const IV = 12;
const TAG = 16;

/** Additional data binding a chunk to its stream and position. */
function aadFor(aad: string, index: number): Buffer {
  return Buffer.from(`${aad}:${index}`, "utf8");
}

/** One self-delimiting frame: u32 length | 12-byte nonce | ciphertext+tag. */
export function sealChunk(key: Buffer, index: number, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadFor(aad, index));
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(IV + body.length);
  return Buffer.concat([len, iv, body]);
}

/**
 * Decrypt every complete frame in order. A partial trailing frame (the process
 * died mid-write) is dropped and reported via `truncated`; anything else that
 * fails to authenticate throws.
 */
/** One self-contained AEAD blob for a single small value (a memory entry), not a stream — unlike sealChunk/openChunks, there is no index or chunking. */
export function sealEntry(key: Buffer, aad: string, plain: Buffer): { nonce: Buffer; data: Buffer } {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { nonce: iv, data };
}

export function openEntry(key: Buffer, aad: string, nonce: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(Buffer.from(aad, "utf8"));
  const tag = data.subarray(data.length - TAG);
  const body = data.subarray(0, data.length - TAG);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

export function openChunks(key: Buffer, aad: string, file: Buffer): { plain: Buffer; truncated: boolean } {
  const out: Buffer[] = [];
  let off = 0;
  let index = 0;
  while (off < file.length) {
    if (file.length - off < 4) return { plain: Buffer.concat(out), truncated: true };
    const len = file.readUInt32BE(off);
    if (len < IV + TAG || off + 4 + len > file.length) return { plain: Buffer.concat(out), truncated: true };
    const iv = file.subarray(off + 4, off + 4 + IV);
    const body = file.subarray(off + 4 + IV, off + 4 + len);
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(aadFor(aad, index));
    d.setAuthTag(body.subarray(body.length - TAG));
    out.push(Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]));
    off += 4 + len;
    index++;
  }
  return { plain: Buffer.concat(out), truncated: false };
}
