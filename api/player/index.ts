import { Router, type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { Player } from "../../models/Player.js";
import {
  getPlayerProfiles,
  invalidatePlayerProfile,
  type ProfileCacheRedis,
} from "./cache.js";

const LEADERBOARD_KEY = "leaderboard:global";

export interface PlayerRedis extends ProfileCacheRedis {
  zScore(key: string, member: string): Promise<number | null>;
  zRevRank(key: string, member: string): Promise<number | null>;
  zRem(key: string, member: string): Promise<number>;
}

export function createPlayerRouter(redis: PlayerRedis): Router {
  const playerRouter = Router();

interface PlayerCreate {
  username: string;
  email: string;
  highScore?: number;
}

interface PlayerPatch {
  username?: string;
  email?: string;
  highScore?: number;
}

function parseCreate(
  body: unknown,
): { ok: true; value: PlayerCreate } | { ok: false; error: string } {
  const parsed = parseFields(body);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.username === undefined || parsed.value.email === undefined) {
    return { ok: false, error: "username and email are required" };
  }
  return {
    ok: true,
    value: {
      username: parsed.value.username,
      email: parsed.value.email,
      ...(parsed.value.highScore !== undefined
        ? { highScore: parsed.value.highScore }
        : {}),
    },
  };
}

function parsePatch(
  body: unknown,
): { ok: true; value: PlayerPatch } | { ok: false; error: string } {
  const parsed = parseFields(body);
  if (!parsed.ok) {
    return parsed;
  }
  if (Object.keys(parsed.value).length === 0) {
    return { ok: false, error: "No player fields to update" };
  }
  return { ok: true, value: parsed.value };
}

function parseFields(
  body: unknown,
): { ok: true; value: PlayerPatch } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be an object" };
  }

  const record = body as Record<string, unknown>;
  const value: PlayerPatch = {};

  if ("username" in record) {
    if (typeof record.username !== "string" || record.username.trim() === "") {
      return { ok: false, error: "username must be a non-empty string" };
    }
    value.username = record.username.trim();
  }

  if ("email" in record) {
    if (typeof record.email !== "string" || record.email.trim() === "") {
      return { ok: false, error: "email must be a non-empty string" };
    }
    value.email = record.email.trim();
  }

  if ("highScore" in record) {
    if (
      typeof record.highScore !== "number" ||
      !Number.isFinite(record.highScore) ||
      record.highScore < 0
    ) {
      return { ok: false, error: "highScore must be a non-negative number" };
    }
    value.highScore = record.highScore;
  }

  return { ok: true, value };
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === 11000
  );
}

function routeId(id: string | undefined): string | undefined {
  if (!id || !mongoose.isValidObjectId(id)) {
    return undefined;
  }
  return id;
}

playerRouter.post("/", async (req, res) => {
  const parsed = parseCreate(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const player = await Player.create(parsed.value);
    res.status(201).json(player);
  } catch (err) {
    if (isDuplicateKey(err)) {
      res.status(409).json({ error: "username or email already exists" });
      return;
    }
    throw err;
  }
});

playerRouter.get("/", async (_req, res) => {
  const players = await Player.find().sort({ createdAt: -1 });
  res.json(players);
});

playerRouter.get("/:id", async (req, res) => {
  const id = routeId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid player id" });
    return;
  }

  const profiles = await getPlayerProfiles(redis, [id]);
  const player = profiles.get(id);
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  const [rank, score] = await Promise.all([
    redis.zRevRank(LEADERBOARD_KEY, id),
    redis.zScore(LEADERBOARD_KEY, id),
  ]);

  res.json({
    ...player,
    score,
    rank: rank === null ? null : rank + 1,
  });
});

playerRouter.patch("/:id", async (req, res) => {
  const id = routeId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid player id" });
    return;
  }

  const parsed = parsePatch(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const player = await Player.findByIdAndUpdate(id, parsed.value, {
      new: true,
      runValidators: true,
    });
    if (!player) {
      res.status(404).json({ error: "Player not found" });
      return;
    }
    await invalidatePlayerProfile(redis, id);
    res.json(player);
  } catch (err) {
    if (isDuplicateKey(err)) {
      res.status(409).json({ error: "username or email already exists" });
      return;
    }
    throw err;
  }
});

playerRouter.delete("/:id", async (req, res) => {
  const id = routeId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid player id" });
    return;
  }

  const player = await Player.findByIdAndDelete(id);
  if (!player) {
    res.status(404).json({ error: "Player not found" });
    return;
  }

  await invalidatePlayerProfile(redis, id);
  try {
    await redis.zRem(LEADERBOARD_KEY, id);
  } catch (err) {
    console.error("Leaderboard removal failed:", err);
  }

  res.status(204).end();
});

const handleError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("Player route error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
};

playerRouter.use(handleError);
return playerRouter;
}
