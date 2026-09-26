import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type LookupHashKind = "ein" | "id4";

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string | null): boolean {
  if (!encoded) return false;
  const [algorithm, saltValue, digestValue] = encoded.split(":");
  if (algorithm !== "scrypt" || !saltValue || !digestValue) return false;
  const expected = Buffer.from(digestValue, "base64url");
  const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function encryptionKey(): Buffer {
  const configured = process.env.MCA_DATA_ENCRYPTION_KEY;
  if (configured) {
    const bytes = Buffer.from(configured, "base64url");
    if (bytes.length !== 32) throw new Error("MCA_DATA_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.");
    return bytes;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCA_DATA_ENCRYPTION_KEY is required in production.");
  }
  // Stable local-only fallback. Production has a hard gate above.
  return createHash("sha256").update("mca-local-development-encryption-key").digest();
}

export function hmacLookup(kind: LookupHashKind, workspaceId: string, normalized: string): string {
  return createHmac("sha256", encryptionKey()).update(`${kind}:${workspaceId}:${normalized}`, "utf8").digest("hex");
}

export function hmacScopedToken(scope: string, workspaceId: string, subject: string): string {
  return createHmac("sha256", encryptionKey()).update(`${scope}:${workspaceId}:${subject}`, "utf8").digest("base64url");
}

export function encryptSensitive(value: string, workspaceId: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(workspaceId));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** True when TOTP secrets can be encrypted with the existing data key (or the local fallback). */
export function totpEncryptionAvailable(): boolean {
  const configured = process.env.MCA_DATA_ENCRYPTION_KEY;
  if (configured) {
    try {
      return Buffer.from(configured, "base64url").length === 32;
    } catch {
      return false;
    }
  }
  return process.env.NODE_ENV !== "production";
}

export function encryptUserSecret(value: string, userId: string): string {
  return encryptSensitive(value, `totp:${userId}`);
}

export function decryptUserSecret(value: string, userId: string): string {
  return decryptSensitive(value, `totp:${userId}`);
}

export function decryptSensitive(value: string, workspaceId: string): string {
  const [version, nonceValue, tagValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted value.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(nonceValue, "base64url"));
  decipher.setAAD(Buffer.from(workspaceId));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}
