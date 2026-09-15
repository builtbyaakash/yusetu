import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

function decodeMasterKey(masterKeyBase64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(masterKeyBase64, "base64");
  } catch {
    throw new Error("GATEWAY_MASTER_KEY must be valid base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `GATEWAY_MASTER_KEY must decode to 32 bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encryptSecret(
  plaintext: string,
  masterKeyBase64: string,
): EncryptedSecret {
  const key = decodeMasterKey(masterKeyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(
  secret: EncryptedSecret,
  masterKeyBase64: string,
): string {
  const key = decodeMasterKey(masterKeyBase64);
  const iv = Buffer.from(secret.iv, "base64");
  const authTag = Buffer.from(secret.authTag, "base64");
  const ciphertext = Buffer.from(secret.ciphertext, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function requireMasterKey(masterKeyBase64: string | undefined): string {
  if (!masterKeyBase64) {
    throw new Error(
      "GATEWAY_MASTER_KEY is required to store or read upstream secrets",
    );
  }
  decodeMasterKey(masterKeyBase64);
  return masterKeyBase64;
}
