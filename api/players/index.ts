import { Router, type ErrorRequestHandler } from "express";
import mongoose from "mongoose";

const LEADERBOARD_KEY = "leaderboard:global";

export interface PlayerRankRedis {
  zRevRank(key: string, member: string): Promise<number | null>;
  zScore(key: string, member: string): Promise<number | null>;
}

function routeId(id: string | undefined): string | undefined {
  if (!id || !mongoose.isValidObjectId(id)) {
    return undefined;
  }
  return id;
}

export function createPlayerRankRouter(redis: PlayerRankRedis): Router {
  const playerRankRouter = Router();

  playerRankRouter.get("/:id/rank", async (req, res) => {
    const id = routeId(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid player id" });
      return;
    }

    const [rank, score] = await Promise.all([
      redis.zRevRank(LEADERBOARD_KEY, id),
      redis.zScore(LEADERBOARD_KEY, id),
    ]);

    if (rank === null || score === null) {
      res.status(404).json({ error: "Player has not registered a score" });
      return;
    }

    res.json({
      playerId: id,
      rank: rank + 1,
      score,
    });
  });

  const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error("Player rank route error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  };

  playerRankRouter.use(handleError);
  return playerRankRouter;
}
