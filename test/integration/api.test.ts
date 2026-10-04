import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { createApp } from "../../app.js";
import { profileKey } from "../../api/player/cache.js";
import { Match } from "../../models/Match.js";
import { Player } from "../../models/Player.js";
import { startTestStack, stopTestStack } from "./setup.js";

let app: Express;
let redis: ReturnType<typeof createClient>;
let sequence = 0;

beforeAll(async () => {
  const stack = await startTestStack();
  app = stack.app;
  redis = stack.redis;
});

afterAll(async () => {
  await stopTestStack();
});

beforeEach(async () => {
  await redis.flushDb();
  await Player.deleteMany({});
  await Match.deleteMany({});
});

async function createPlayer(username: string) {
  sequence += 1;
  const response = await request(app).post("/api/player").send({
    username: `  ${username}  `,
    email: ` ${username}-${sequence}@example.com `,
  });
  expect(response.status).toBe(201);
  return response.body as {
    _id: string;
    username: string;
    email: string;
    highScore: number;
  };
}

async function postScore(playerId: string, score: number) {
  const response = await request(app)
    .post("/api/scores")
    .send({ playerId, score });
  expect(response.status).toBe(201);
  return response.body as { highScore: number; match: { score: number } };
}

describe("throttleboard API", () => {
  it("keeps the higher score and both match records", async () => {
    const player = await createPlayer("ada");
    expect(player.username).toBe("ada");
    expect(player.highScore).toBe(0);

    const higher = await postScore(player._id, 40);
    const lower = await postScore(player._id, 15);

    expect(higher.highScore).toBe(40);
    expect(lower.highScore).toBe(40);
    expect(await Match.countDocuments({ playerId: player._id })).toBe(2);
    expect(await redis.zScore("leaderboard:global", player._id)).toBe(40);

    const stored = await Player.findById(player._id);
    expect(stored?.highScore).toBe(40);
  });

  it("orders the leaderboard from the sorted set and ignores a lower score", async () => {
    const ada = await createPlayer("ada");
    const grace = await createPlayer("grace");
    await postScore(ada._id, 40);
    await postScore(grace._id, 90);
    await postScore(ada._id, 10);

    const leaderboard = await request(app).get("/api/leaderboard?limit=2");
    const rank = await request(app).get(`/api/players/${ada._id}/rank`);

    expect(leaderboard.status).toBe(200);
    expect(leaderboard.body).toEqual([
      { rank: 1, playerId: grace._id, username: "grace", score: 90 },
      { rank: 2, playerId: ada._id, username: "ada", score: 40 },
    ]);
    expect(rank.status).toBe(200);
    expect(rank.body).toEqual({ playerId: ada._id, rank: 2, score: 40 });
  });

  it("returns 404 when a player has no sorted-set score", async () => {
    const player = await createPlayer("ada");

    const rank = await request(app).get(`/api/players/${player._id}/rank`);
    const profile = await request(app).get(`/api/player/${player._id}`);

    expect(rank.status).toBe(404);
    expect(profile.status).toBe(200);
    expect(profile.body.score).toBeNull();
    expect(profile.body.rank).toBeNull();
  });

  it("serves a cached profile until the player is updated", async () => {
    const player = await createPlayer("ada");
    await postScore(player._id, 40);

    const first = await request(app).get(`/api/player/${player._id}`);
    expect(first.body).toMatchObject({
      username: "ada",
      score: 40,
      rank: 1,
    });
    expect(await redis.get(profileKey(player._id))).toContain("\"username\":\"ada\"");

    await Player.deleteOne({ _id: player._id });
    const cached = await request(app).get(`/api/player/${player._id}`);
    expect(cached.status).toBe(200);
    expect(cached.body.username).toBe("ada");

    await Player.create({
      _id: player._id,
      username: "ada",
      email: `${player.email}`,
      highScore: 40,
    });
    const updated = await request(app)
      .patch(`/api/player/${player._id}`)
      .send({ username: "grace" });
    expect(updated.status).toBe(200);
    expect(await redis.get(profileKey(player._id))).toBeNull();

    const reloaded = await request(app).get(`/api/player/${player._id}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.username).toBe("grace");
    expect(reloaded.body.score).toBe(40);
  });

  it("removes a deleted player from the leaderboard", async () => {
    const player = await createPlayer("ada");
    await postScore(player._id, 25);

    const removed = await request(app).delete(`/api/player/${player._id}`);
    const rank = await request(app).get(`/api/players/${player._id}/rank`);
    const leaderboard = await request(app).get("/api/leaderboard");

    expect(removed.status).toBe(204);
    expect(await redis.zScore("leaderboard:global", player._id)).toBeNull();
    expect(await redis.get(profileKey(player._id))).toBeNull();
    expect(rank.status).toBe(404);
    expect(leaderboard.body).toEqual([]);
  });

  it("rejects a duplicate player and a negative score", async () => {
    await createPlayer("ada");
    const duplicate = await request(app).post("/api/player").send({
      username: "ada",
      email: "other@example.com",
    });
    const player = await createPlayer("grace");
    const negative = await request(app)
      .post("/api/scores")
      .send({ playerId: player._id, score: -1 });

    expect(duplicate.status).toBe(409);
    expect(negative.status).toBe(400);
    expect(await Match.countDocuments({})).toBe(0);
  });

  it("returns 429 from Redis when the create limit is one", async () => {
    const tight = createApp(redis, {
      read: { windowSec: 60, maxRequests: 1 },
      score: { windowSec: 60, maxRequests: 1 },
      createAccount: { windowSec: 3600, maxRequests: 1 },
    });

    const first = await request(tight).post("/api/player").send({
      username: "ada",
      email: "ada@example.com",
    });
    const second = await request(tight).post("/api/player").send({
      username: "grace",
      email: "grace@example.com",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("Too Many Requests");
  });
});
