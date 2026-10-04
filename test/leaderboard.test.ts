import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import {
  createLeaderboardRouter,
  type LeaderboardRedis,
} from "../api/leaderboard/index.js";
import { Player } from "../models/Player.js";

interface LeaderboardEntry {
  rank: number;
  playerId: string;
  username: string;
  score: number;
}

interface ErrorJson {
  error: string;
}

interface RangeCall {
  key: string;
  min: number;
  max: number;
  REV: true;
}

let mongo: MongoMemoryServer | undefined;
let server: Server | undefined;
let baseUrl = "";
let rangeResult: Array<{ value: string; score: number }> = [];
let rangeCalls: RangeCall[] = [];
let redisFails = false;

const redis: LeaderboardRedis = {
  async zRangeWithScores(key, min, max, options) {
    if (redisFails) {
      throw new Error("redis down");
    }
    rangeCalls.push({ key, min, max, REV: options.REV });
    return rangeResult;
  },
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const app = express();
  app.use(express.json());
  app.use("/api/leaderboard", createLeaderboardRouter(redis));
  const listening = app.listen(0, "127.0.0.1");
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/leaderboard`;
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
  rangeResult = [];
  rangeCalls = [];
  redisFails = false;
  await Player.deleteMany({});
});

async function request(path = "") {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

function asLeaderboard(json: unknown): LeaderboardEntry[] {
  assert.ok(Array.isArray(json));
  return json.map((entry) => {
    assert.ok(entry && typeof entry === "object");
    const row = entry as LeaderboardEntry;
    assert.equal(typeof row.rank, "number");
    assert.equal(typeof row.playerId, "string");
    assert.equal(typeof row.username, "string");
    assert.equal(typeof row.score, "number");
    return row;
  });
}

function asError(json: unknown): string {
  assert.ok(json && typeof json === "object" && "error" in json);
  return (json as ErrorJson).error;
}

async function createPlayer(username: string) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return Player.create({
    username,
    email: `${suffix}@example.com`,
    highScore: 0,
  });
}

describe("leaderboard routes", { concurrency: 1 }, () => {
  it("returns redis order with rank, score, and username", async () => {
    const ada = await createPlayer("ada");
    const grace = await createPlayer("grace");
    const linus = await createPlayer("linus");
    rangeResult = [
      { value: grace._id.toString(), score: 90 },
      { value: ada._id.toString(), score: 40 },
      { value: linus._id.toString(), score: 10 },
    ];

    const response = await request("?limit=3");

    assert.equal(response.status, 200);
    assert.deepEqual(asLeaderboard(response.json), [
      { rank: 1, playerId: grace._id.toString(), username: "grace", score: 90 },
      { rank: 2, playerId: ada._id.toString(), username: "ada", score: 40 },
      { rank: 3, playerId: linus._id.toString(), username: "linus", score: 10 },
    ]);
    assert.deepEqual(rangeCalls, [
      { key: "leaderboard:global", min: 0, max: 2, REV: true },
    ]);
  });

  it("defaults to the top 10", async () => {
    const response = await request();

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, []);
    assert.deepEqual(rangeCalls, [
      { key: "leaderboard:global", min: 0, max: 9, REV: true },
    ]);
  });

  it("keeps the redis rank when a player record is missing", async () => {
    const ada = await createPlayer("ada");
    rangeResult = [
      { value: "507f1f77bcf86cd799439011", score: 80 },
      { value: ada._id.toString(), score: 20 },
    ];

    const response = await request("?limit=2");

    assert.equal(response.status, 200);
    assert.deepEqual(asLeaderboard(response.json), [
      { rank: 2, playerId: ada._id.toString(), username: "ada", score: 20 },
    ]);
  });

  it("rejects a limit that is not a positive integer within range", async () => {
    const zero = await request("?limit=0");
    const word = await request("?limit=ten");
    const huge = await request("?limit=101");

    assert.equal(zero.status, 400);
    assert.equal(asError(zero.json), "limit must be a positive integer");
    assert.equal(word.status, 400);
    assert.equal(huge.status, 400);
    assert.equal(asError(huge.json), "limit must be at most 100");
    assert.equal(rangeCalls.length, 0);
  });

  it("returns 500 when redis fails", async () => {
    redisFails = true;

    const response = await request();

    assert.equal(response.status, 500);
    assert.equal(asError(response.json), "Internal server error");
  });
});
