import { Router, type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { Match } from "../../models/Match.js";
import { Player } from "../../models/Player.js";

const LEADERBOARD_KEY = "leaderboard:global";

export interface LeaderboardRedis {
  zAdd(
    key: string,
    member: { score: number; value: string },
    options: { comparison: "GT" },
  ): Promise<number>;
}

interface ScoreCreate {
  playerId: string;
  score: number;
}

function parseCreate(
  body: unknown,
): { ok: true; value: ScoreCreate } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object" };
  }

  const record = body as Record<string, unknown>;
  if (!("playerId" in record) || !("score" in record)) {
    return { ok: false, error: "playerId and score are required" };
  }

  if (typeof record.playerId !== "string" || !mongoose.isValidObjectId(record.playerId)) {
    return { ok: false, error: "Invalid player id" };
  }

  if (
    typeof record.score !== "number" ||
    !Number.isFinite(record.score) ||
    record.score < 0
  ) {
    return { ok: false, error: "score must be a non-negative number" };
  }

  return { ok: true, value: { playerId: record.playerId, score: record.score } };
}

export function createScoresRouter(redis: LeaderboardRedis): Router {
  const scoresRouter = Router();

  scoresRouter.post("/", async (req, res) => {
    const parsed = parseCreate(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const playerExists = await Player.exists({ _id: parsed.value.playerId });
    if (!playerExists) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const match = await Match.create({
      playerId: parsed.value.playerId,
      score: parsed.value.score,
    });

    const player = await Player.findByIdAndUpdate(
      parsed.value.playerId,
      { $max: { highScore: parsed.value.score } },
      { new: true },
    );
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    await redis.zAdd(
      LEADERBOARD_KEY,
      { score: parsed.value.score, value: parsed.value.playerId },
      { comparison: "GT" },
    );

    res.status(201).json({ match, highScore: player.highScore });
  });

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("Scores route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  };

  scoresRouter.use(handleError);
  return scoresRouter;
}
