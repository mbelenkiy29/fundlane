import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashOpaqueToken } from "./crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

export function totpUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.account);
  return `otpauth://totp/${issuer}:${account}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

export function generateTotpCode(secret: string, timestamp = Date.now()): string {
  return hotp(secret, Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS));
}

export function verifyTotpCode(secret: string, code: string, timestamp = Date.now()): { valid: boolean; counter?: number } {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return { valid: false };
  const current = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(hotp(secret, counter), "utf8");
    const actual = Buffer.from(normalized, "utf8");
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return { valid: true, counter };
  }
  return { valid: false };
}

export function normalizeTotpCode(code: string): string | null {
  const digits = code.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(formatRecoveryCode(randomBytes(8).toString("hex").toUpperCase()));
  return [...codes];
}

export function formatRecoveryCode(rawHex: string): string {
  const hex = rawHex.replace(/[^0-9A-Fa-f]/g, "").toUpperCase().padEnd(16, "0").slice(0, 16);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

export function normalizeRecoveryCode(code: string): string | null {
  const hex = code.replace(/[-\s]/g, "").toUpperCase();
  return /^[0-9A-F]{16}$/.test(hex) ? formatRecoveryCode(hex) : null;
}

export function hashRecoveryCode(code: string): string | null {
  const normalized = normalizeRecoveryCode(code);
  return normalized ? hashOpaqueToken(normalized) : null;
}

function hotp(secret: string, counter: number): string {
  const key = fromBase32(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter & 0xffffffff, 4);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function fromBase32(secret: string): Buffer {
  const cleaned = secret.replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
