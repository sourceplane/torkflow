/** Prefixed, sortable identifiers. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * `<prefix>_<base36 millisecond timestamp><random>`. The timestamp prefix keeps
 * ids roughly sortable by creation, which makes run listings cheap.
 */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${random}`;
}

/** Hex SHA-256 — used for bundle digests and API key hashes. */
export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison, for tokens and signatures. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
