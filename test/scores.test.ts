import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import {
  createScoresRouter,
  type LeaderboardRedis,
} from "../api/scores/index.js";
import { Match } from "../models/Match.js";
import { Player } from "../models/Player.js";

interface MatchJson {
  _id: string;
  playerId: string;
  score: number;
  playedAt: string;
}

interface ScoreJson {
  match: MatchJson;
  highScore: number;
}

interface ErrorJson {
  error: string;
}

interface ZAddCall {
  key: string;
  score: number;
  value: string;
  comparison: "GT";
}

let mongo: MongoMemoryServer | undefined;
let server: Server | undefined;
let baseUrl = "";
let zAddCalls: ZAddCall[] = [];
let redisFails = false;

const redis: LeaderboardRedis = {
  async zAdd(key, member, options) {
    if (redisFails) {
      throw new Error("redis down");
    }
    zAddCalls.push({
      key,
      score: member.score,
      value: member.value,
      comparison: options.comparison,
    });
    return 1;
  },
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const app = express();
  app.use(express.json());
  app.use("/api/scores", createScoresRouter(redis));
  const listening = app.listen(0, "127.0.0.1");
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/scores`;
}, { timeout: 120_000 });

after(async () => {
  if (server) {
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.closeAllConnections();
      listening.close((err) => (err ? reject(err) : resolve()));
    });
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongo?.stop();
});

beforeEach(async () => {
  zAddCalls = [];
  redisFails = false;
  await Match.deleteMany({});
  await Player.deleteMany({});
});

async function request(method: string, path = "", body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

function asScore(json: unknown): ScoreJson {
  assert.ok(json && typeof json === "object" && "match" in json);
  const body = json as ScoreJson;
  assert.equal(typeof body.highScore, "number");
  assert.equal(typeof body.match._id, "string");
  assert.equal(typeof body.match.playerId, "string");
  assert.equal(typeof body.match.score, "number");
  assert.ok(body.match.playedAt);
  return body;
}

function asError(json: unknown): string {
  assert.ok(json && typeof json === "object" && "error" in json);
  return (json as ErrorJson).error;
}

async function createPlayer(highScore = 0) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return Player.create({
    username: `player-${suffix}`,
    email: `${suffix}@example.com`,
    highScore,
  });
}

describe("score routes", { concurrency: 1 }, () => {
  it("creates a match, raises the high score, and writes the leaderboard", async () => {
    const player = await createPlayer(10);
    const earlier = await Match.create({ playerId: player._id, score: 10 });

    const response = await request("POST", "", {
      playerId: player._id.toString(),
      score: 42,
    });

    assert.equal(response.status, 201);
    const body = asScore(response.json);
    assert.notEqual(body.match._id, earlier._id.toString());
    assert.equal(body.match.playerId, player._id.toString());
    assert.equal(body.match.score, 42);
    assert.equal(body.highScore, 42);

    const storedEarlier = await Match.findById(earlier._id);
    const storedPlayer = await Player.findById(player._id);
    assert.equal(storedEarlier?.score, 10);
    assert.equal(await Match.countDocuments({ playerId: player._id }), 2);
    assert.equal(storedPlayer?.highScore, 42);
    assert.deepEqual(zAddCalls, [
      {
        key: "leaderboard:global",
        score: 42,
        value: player._id.toString(),
        comparison: "GT",
      },
    ]);
  });

  it("keeps the existing high score when the new score is lower", async () => {
    const player = await createPlayer(100);
    const earlier = await Match.create({ playerId: player._id, score: 100 });

    const response = await request("POST", "", {
      playerId: player._id.toString(),
      score: 40,
    });

    assert.equal(response.status, 201);
    const body = asScore(response.json);
    assert.equal(body.match.score, 40);
    assert.equal(body.highScore, 100);
    assert.equal((await Match.findById(earlier._id))?.score, 100);
    assert.equal((await Player.findById(player._id))?.highScore, 100);
    assert.equal(zAddCalls[0]?.score, 40);
    assert.equal(zAddCalls[0]?.comparison, "GT");
  });

  it("rejects a missing, invalid, or negative score", async () => {
    const player = await createPlayer();
    const playerId = player._id.toString();

    const missing = await request("POST", "", { playerId });
    const negative = await request("POST", "", { playerId, score: -1 });
    const invalid = await request("POST", "", { playerId, score: "10" });

    assert.equal(missing.status, 400);
    assert.equal(asError(missing.json), "playerId and score are required");
    assert.equal(negative.status, 400);
    assert.equal(asError(negative.json), "score must be a non-negative number");
    assert.equal(invalid.status, 400);
    assert.equal(zAddCalls.length, 0);
    assert.equal(await Match.countDocuments({}), 0);
  });

  it("returns 400 for a bad player id and 404 when the player is missing", async () => {
    const invalid = await request("POST", "", {
      playerId: "not-an-id",
      score: 5,
    });
    const missing = await request("POST", "", {
      playerId: "507f1f77bcf86cd799439011",
      score: 5,
    });

    assert.equal(invalid.status, 400);
    assert.equal(asError(invalid.json), "Invalid player id");
    assert.equal(missing.status, 404);
    assert.equal(asError(missing.json), "Player not found");
    assert.equal(zAddCalls.length, 0);
    assert.equal(await Match.countDocuments({}), 0);
  });

  it("returns 500 when redis fails after the match is stored", async () => {
    const player = await createPlayer(1);
    redisFails = true;

    const response = await request("POST", "", {
      playerId: player._id.toString(),
      score: 8,
    });

    assert.equal(response.status, 500);
    assert.equal(asError(response.json), "Internal server error");
    assert.equal(await Match.countDocuments({ playerId: player._id }), 1);
    assert.equal((await Match.findOne({ playerId: player._id }))?.score, 8);
    assert.equal((await Player.findById(player._id))?.highScore, 8);
  });
});
