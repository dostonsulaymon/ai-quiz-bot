import { Redis } from "ioredis";
import { config } from "../config/index.js";

export const createRedisClient = (): Redis => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true
  });

  redis.on("connect", () => {
    console.info("[redis] Connected");
  });

  redis.on("error", (error: Error) => {
    console.error("[redis] Error", error);
  });

  redis.on("close", () => {
    console.warn("[redis] Connection closed");
  });

  return redis;
};
