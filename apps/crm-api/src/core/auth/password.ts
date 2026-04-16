import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors.js";

const HASH_PREFIX = "scrypt-v1";
const KEY_LENGTH = 64;

export function hashPassword(password: string) {
  const normalized = password.trim();
  if (normalized.length < 8) {
    throw new HttpError(422, "Пароль должен содержать минимум 8 символов");
  }

  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(normalized, salt, KEY_LENGTH).toString("hex");
  return `${HASH_PREFIX}$${salt}$${hash}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [prefix, salt, storedHash] = passwordHash.split("$");
  if (prefix !== HASH_PREFIX || !salt || !storedHash) {
    return false;
  }

  const incomingHash = scryptSync(password.trim(), salt, KEY_LENGTH).toString("hex");
  const incomingBuffer = Buffer.from(incomingHash, "hex");
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (incomingBuffer.length !== storedBuffer.length) {
    return false;
  }

  return timingSafeEqual(incomingBuffer, storedBuffer);
}
