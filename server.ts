import "dotenv/config";
import type { Server } from "node:http";
import express from "express";
import mongoose from "mongoose";
import { createClient } from "redis";
import { createLeaderboardRouter } from "./api/leaderboard/index.js";
import { playerRouter } from "./api/player/index.js";
import { createPlayerRankRouter } from "./api/players/index.js";
import { createScoresRouter } from "./api/scores/index.js";
import { createRateLimiter } from "./middleware/rateLimiter.js";

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/throttleboard";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const redis = createClient({ url: REDIS_URL });
redis.on("error", (err: Error) => {
  console.error("Redis client error:", err.message);
});

const app = express();
app.use(express.json());

const readLimiter = createRateLimiter(redis, {
  windowSec: 60,
  maxRequests: 60,
  name: "read",
});
const scoreLimiter = createRateLimiter(redis, {
  windowSec: 60,
  maxRequests: 10,
  name: "score",
});
const createAccountLimiter = createRateLimiter(redis, {
  windowSec: 3600,
  maxRequests: 5,
  name: "create-account",
});

app.post("/api/player", createAccountLimiter);
app.post("/api/scores", scoreLimiter);
app.get("/api/players/:id/rank", readLimiter);
app.get("/api/leaderboard", readLimiter);

app.use("/api/player", playerRouter);
app.use("/api/players", createPlayerRankRouter(redis));
app.use("/api/scores", createScoresRouter(redis));
app.use("/api/leaderboard", createLeaderboardRouter(redis));

app.get("/health", async (_req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  let redisUp = false;

  try {
    redisUp = redis.isOpen && (await redis.ping()) === "PONG";
  } catch {
    redisUp = false;
  }

  const ok = mongoUp && redisUp;
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    mongo: mongoUp ? "up" : "down",
    redis: redisUp ? "up" : "down",
  });
});

app.get("/", (_req, res) => {
  res.json({ service: "throttleboard", status: "running" });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(
  label: string,
  connect: () => Promise<unknown>,
  attempts = 20,
): Promise<void> {
  let lastError: unknown = new Error(`${label} failed to connect`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await connect();
      console.log(`${label} connected`);
      return;
    } catch (err) {
      lastError = err;
      console.log(`${label} not ready (${attempt}/${attempts})`);
      await sleep(1000);
    }
  }
  throw lastError;
}

async function shutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (redis.isOpen) {
    await redis.quit();
  }
  await mongoose.disconnect();
}

async function start(): Promise<void> {
  await connectWithRetry("MongoDB", () => mongoose.connect(MONGODB_URI));
  await connectWithRetry("Redis", () => redis.connect());

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`ThrottleBoard listening on port ${PORT}`);
  });

  const stop = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    try {
      await shutdown(server);
      process.exit(0);
    } catch (err) {
      console.error("Shutdown failed:", err);
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

start().catch((err: unknown) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
