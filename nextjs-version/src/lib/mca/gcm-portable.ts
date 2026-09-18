import { gcm } from "@noble/ciphers/aes.js"

/** Same v1 AES-GCM wire format; avoids incomplete Node crypto emulation on hosted Edge. */
export function encryptGcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array) {
  const encrypted = gcm(key, nonce, aad).encrypt(plaintext)
  return { ciphertext: encrypted.subarray(0, -16), tag: encrypted.subarray(-16) }
}
export function decryptGcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array): Uint8Array {
  if (tag.byteLength !== 16) throw new Error("Invalid authentication tag")
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength)
  combined.set(ciphertext); combined.set(tag, ciphertext.byteLength)
  return gcm(key, nonce, aad).decrypt(combined)
}
