import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateId(prefix: string = "", length: number = 12): string {
  const bytes = randomBytes(length);
  let id = prefix ? `${prefix}_` : "";
  for (let i = 0; i < length; i++) {
    id += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return id;
}
