import type { Express } from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createClient } from "redis";
import { RedisMemoryServer } from "redis-memory-server";
import { createApp, type AppLimits } from "../../app.js";
import { Player } from "../../models/Player.js";

export const relaxedLimits: AppLimits = {
  read: { windowSec: 60, maxRequests: 10_000 },
  score: { windowSec: 60, maxRequests: 10_000 },
  createAccount: { windowSec: 60, maxRequests: 10_000 },
};

export interface TestStack {
  app: Express;
  redis: ReturnType<typeof createClient>;
}

let mongo: MongoMemoryServer | undefined;
let redisServer: RedisMemoryServer | undefined;
let redis: ReturnType<typeof createClient> | undefined;

export async function startTestStack(): Promise<TestStack> {
  mongo = await MongoMemoryServer.create();
  redisServer = await RedisMemoryServer.create();
  const host = await redisServer.getHost();
  const port = await redisServer.getPort();

  await mongoose.connect(mongo.getUri());
  await Player.createIndexes();

  redis = createClient({ url: `redis://${host}:${port}` });
  redis.on("error", () => {});
  await redis.connect();

  return {
    app: createApp(redis, relaxedLimits),
    redis,
  };
}

export async function stopTestStack(): Promise<void> {
  if (redis?.isOpen) {
    await redis.quit();
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await redisServer?.stop();
  await mongo?.stop();
}
