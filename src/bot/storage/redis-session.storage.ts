import type { StorageAdapter } from "grammy";
import type { Redis } from "ioredis";
import { logger } from "../../shared/logger.js";

const SESSION_PREFIX = "quiz-bot:session";

export class RedisSessionStorage<T> implements StorageAdapter<T> {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds?: number,
    private readonly onCorrupt?: () => T
  ) {}

  async read(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.buildKey(key));
    if (!raw) {
      return undefined;
    }

    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.warn("Session parse failed, resetting session", {
        sessionKey: key,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.delete(key);
      return this.onCorrupt?.();
    }
  }

  async write(key: string, value: T): Promise<void> {
    const storageKey = this.buildKey(key);
    const payload = JSON.stringify(value);

    if (this.ttlSeconds) {
      await this.redis.set(storageKey, payload, "EX", this.ttlSeconds);
      return;
    }

    await this.redis.set(storageKey, payload);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.buildKey(key));
  }

  private buildKey(key: string): string {
    return `${SESSION_PREFIX}:${key}`;
  }
}
