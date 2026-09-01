import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export function normalizeUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validCredentials(username, password) {
  return username.length >= 3 && username.length <= 32 && /^[a-z0-9_]+$/.test(username)
    && typeof password === "string" && password.length >= 8 && password.length <= 256;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, keyLength);
  return `scrypt$${salt}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, record) {
  const [algorithm, salt, encodedKey] = String(record).split("$");
  if (algorithm !== "scrypt" || !salt || !encodedKey) return false;
  const expected = Buffer.from(encodedKey, "base64url");
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
