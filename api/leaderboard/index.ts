import { Router, type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { Player } from "../../models/Player.js";

const LEADERBOARD_KEY = "leaderboard:global";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export interface LeaderboardRedis {
  zRangeWithScores(
    key: string,
    min: number,
    max: number,
    options: { REV: true },
  ): Promise<Array<{ value: string; score: number }>>;
}

function parseLimit(
  raw: unknown,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, limit: DEFAULT_LIMIT };
  }

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "limit must be a positive integer" };
  }

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, error: "limit must be a positive integer" };
  }
  if (limit > MAX_LIMIT) {
    return { ok: false, error: `limit must be at most ${MAX_LIMIT}` };
  }

  return { ok: true, limit };
}

export function createLeaderboardRouter(redis: LeaderboardRedis): Router {
  const leaderboardRouter = Router();

  leaderboardRouter.get("/", async (req, res) => {
    const parsed = parseLimit(req.query.limit);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const ranked = await redis.zRangeWithScores(
      LEADERBOARD_KEY,
      0,
      parsed.limit - 1,
      { REV: true },
    );

    const playerIds = ranked
      .map((entry) => entry.value)
      .filter((id) => mongoose.isValidObjectId(id));
    const players =
      playerIds.length === 0
        ? []
        : await Player.find({ _id: { $in: playerIds } });
    const playersById = new Map(
      players.map((player) => [player._id.toString(), player]),
    );

    const leaderboard = ranked.flatMap((entry, index) => {
      const player = playersById.get(entry.value);
      if (!player) {
        return [];
      }
      return [
        {
          rank: index + 1,
          playerId: entry.value,
          username: player.username,
          score: entry.score,
        },
      ];
    });

    res.json(leaderboard);
  });

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("Leaderboard route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  };

  leaderboardRouter.use(handleError);
  return leaderboardRouter;
}
