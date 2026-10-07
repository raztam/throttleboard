import { Router, type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { getPlayerProfiles, type ProfileCacheRedis } from "../player/cache.js";
import {
  type ViewTimeframe,
  viewsLeaderboardKey,
} from "../player/viewKeys.js";

const TOP_COUNT = 100;

export interface MostViewedRedis extends ProfileCacheRedis {
  zRangeWithScores(
    key: string,
    min: number,
    max: number,
    options: { REV: true },
  ): Promise<Array<{ value: string; score: number }>>;
}

function parseTimeframe(
  raw: unknown,
): { ok: true; timeframe: ViewTimeframe } | { ok: false; error: string } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return { ok: true, timeframe: "all" };
  }
  if (value === "all" || value === "daily" || value === "weekly") {
    return { ok: true, timeframe: value };
  }
  return { ok: false, error: "timeframe must be all, daily, or weekly" };
}

export function createMostViewedRouter(redis: MostViewedRedis): Router {
  const mostViewedRouter = Router();

  mostViewedRouter.get("/most-viewed", async (req, res) => {
    const parsed = parseTimeframe(req.query.timeframe);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const ranked = await redis.zRangeWithScores(
      viewsLeaderboardKey(parsed.timeframe),
      0,
      TOP_COUNT - 1,
      { REV: true },
    );

    const playerIds = ranked
      .map((entry) => entry.value)
      .filter((id) => mongoose.isValidObjectId(id));
    const playersById = await getPlayerProfiles(redis, playerIds);

    const mostViewed = ranked.flatMap((entry, index) => {
      const player = playersById.get(entry.value);
      if (!player) {
        return [];
      }
      return [
        {
          rank: index + 1,
          playerId: entry.value,
          username: player.username,
          views: entry.score,
        },
      ];
    });

    res.json(mostViewed);
  });

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("Most viewed route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  };

  mostViewedRouter.use(handleError);
  return mostViewedRouter;
}
