import test from "node:test";
import assert from "node:assert/strict";
import { validateJobResource } from "../src/lib/mca/db";
import { decryptSensitive, encryptSensitive } from "../src/lib/mca/crypto";

test("queued resource validation rejects tenant mismatches without returning the resource", async () => {
  const resource = { id: "merchant-123", workspaceId: "workspace-a" };
  assert.equal(
    validateJobResource(
      { workspaceId: "workspace-a", resourceType: "merchant", resourceId: resource.id },
      () => resource,
    ),
    resource,
  );
  assert.throws(
    () => validateJobResource(
      { workspaceId: "workspace-b", resourceType: "merchant", resourceId: resource.id },
      () => resource,
    ),
    (error: unknown) => {
      const candidate = error as { status?: number; code?: string; message?: string };
      assert.equal(candidate.status, 404);
      assert.equal(candidate.code, "resource_not_found");
      assert.equal(candidate.message?.includes("workspace-a"), false);
      return true;
    },
  );
});

test("sensitive field encryption is bound to the workspace", async () => {
  process.env.MCA_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
  const plaintext = "12-3456789";
  const encrypted = encryptSensitive(plaintext, "workspace-a");
  assert.equal(encrypted.includes(plaintext), false);
  assert.equal(decryptSensitive(encrypted, "workspace-a"), plaintext);
  assert.throws(() => decryptSensitive(encrypted, "workspace-b"));
});

test("empty sensitive values round-trip and stay authenticated", async () => {
  process.env.MCA_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
  const empty = encryptSensitive("", "workspace-a");
  const [version, nonce, tag, ciphertext] = empty.split(".");
  assert.equal(version, "v1");
  assert.equal(ciphertext, "");
  assert.equal(decryptSensitive(empty, "workspace-a"), "");
  assert.throws(() => decryptSensitive(empty, "workspace-b"));
  const tagBytes = Buffer.from(tag, "base64url"); tagBytes[0] ^= 1
  assert.throws(() => decryptSensitive(["v1", nonce, tagBytes.toString("base64url"), ""].join("."), "workspace-a"));
  const invalid = /Invalid encrypted value/
  assert.throws(() => decryptSensitive(`v1.${nonce}.${tag}`, "workspace-a"), invalid);
  assert.throws(() => decryptSensitive(`v1..${tag}.`, "workspace-a"), invalid);
  assert.throws(() => decryptSensitive(`v1.${nonce}..`, "workspace-a"), invalid);
  assert.throws(() => decryptSensitive(`v1.${nonce}.${tag}..`, "workspace-a"), invalid);
  assert.throws(() => decryptSensitive(`v1.${nonce}.${tag.slice(0, 8)}.`, "workspace-a"), invalid);
  assert.throws(() => decryptSensitive(`v1.${nonce.slice(0, 8)}.${tag}.`, "workspace-a"), invalid);
});
