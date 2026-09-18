import { createCipheriv, createDecipheriv } from "node:crypto"

export function encryptGcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(aad)
  return { ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), tag: cipher.getAuthTag() }
}
export function decryptGcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
