import express, { type Express } from "express";
import mongoose from "mongoose";
import { createClient } from "redis";

type AppRedis = ReturnType<typeof createClient>;
import { createLeaderboardRouter } from "./api/leaderboard/index.js";
import { createPlayerRouter } from "./api/player/index.js";
import { createPlayerRankRouter } from "./api/players/index.js";
import { createScoresRouter } from "./api/scores/index.js";
import {
  createRateLimiter,
  type RateLimiterOptions,
} from "./middleware/rateLimiter.js";

export interface AppLimits {
  read: Pick<RateLimiterOptions, "windowSec" | "maxRequests">;
  score: Pick<RateLimiterOptions, "windowSec" | "maxRequests">;
  createAccount: Pick<RateLimiterOptions, "windowSec" | "maxRequests">;
}

const productionLimits: AppLimits = {
  read: { windowSec: 60, maxRequests: 60 },
  score: { windowSec: 60, maxRequests: 10 },
  createAccount: { windowSec: 3600, maxRequests: 5 },
};

export function createApp(
  redis: AppRedis,
  limits: AppLimits = productionLimits,
): Express {
  const app = express();
  app.use(express.json());

  const readLimiter = createRateLimiter(redis, {
    ...limits.read,
    name: "read",
  });
  const scoreLimiter = createRateLimiter(redis, {
    ...limits.score,
    name: "score",
  });
  const createAccountLimiter = createRateLimiter(redis, {
    ...limits.createAccount,
    name: "create-account",
  });

  app.post("/api/player", createAccountLimiter);
  app.post("/api/scores", scoreLimiter);
  app.get("/api/players/:id/rank", readLimiter);
  app.get("/api/leaderboard", readLimiter);

  app.use("/api/player", createPlayerRouter(redis));
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

  return app;
}
