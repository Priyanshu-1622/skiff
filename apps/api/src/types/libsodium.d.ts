declare module "libsodium-wrappers" {
  export const ready: Promise<void>;
  export const crypto_secretbox_NONCEBYTES: number;
  export const crypto_secretbox_KEYBYTES: number;
  export function randombytes_buf(length: number): Uint8Array;
  export function crypto_secretbox_easy(message: Uint8Array, nonce: Uint8Array, key: Uint8Array | Buffer): Uint8Array;
  export function crypto_secretbox_open_easy(ciphertext: Uint8Array, nonce: Uint8Array, key: Uint8Array | Buffer): Uint8Array | null;
  export function from_string(str: string): Uint8Array;
  export function to_string(buf: Uint8Array): string;
}
