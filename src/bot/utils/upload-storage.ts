import type { Redis } from "ioredis";

const UPLOAD_TTL_SECONDS = 3600; // 1 hour — enough for any upload flow

export async function storeUploadData(
  redis: Redis,
  userId: number,
  fileId: string,
  base64: string
): Promise<string> {
  const key = `upload:${userId}:${fileId}`;
  await redis.set(key, base64, "EX", UPLOAD_TTL_SECONDS);
  return key;
}

export async function getUploadData(
  redis: Redis,
  storageKey: string
): Promise<string | null> {
  return redis.get(storageKey);
}

export async function deleteAllUploadData(
  redis: Redis,
  storageKeys: string[]
): Promise<void> {
  if (storageKeys.length === 0) return;
  await redis.del(...storageKeys);
}
