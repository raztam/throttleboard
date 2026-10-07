import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import {
  createMostViewedRouter,
  type MostViewedRedis,
} from "../api/players/mostViewed.js";
import {
  VIEWS_ALL_KEY,
  dailyViewsKey,
  weeklyViewsKey,
} from "../api/player/viewKeys.js";
import { Player } from "../models/Player.js";

interface MostViewedEntry {
  rank: number;
  playerId: string;
  username: string;
  views: number;
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
const cache = new Map<string, string>();

const redis: MostViewedRedis = {
  async zRangeWithScores(key, min, max, options) {
    rangeCalls.push({ key, min, max, REV: options.REV });
    return rangeResult;
  },
  async mGet(keys) {
    return keys.map((key) => cache.get(key) ?? null);
  },
  async set(key, value) {
    cache.set(key, value);
    return "OK";
  },
  async del(key) {
    cache.delete(key);
    return 1;
  },
  async zScore() {
    return null;
  },
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const app = express();
  app.use(express.json());
  app.use("/api/players", createMostViewedRouter(redis));
  const listening = app.listen(0, "127.0.0.1");
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/players/most-viewed`;
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
  cache.clear();
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

function asMostViewed(json: unknown): MostViewedEntry[] {
  assert.ok(Array.isArray(json));
  return json.map((entry) => {
    assert.ok(entry && typeof entry === "object");
    const row = entry as MostViewedEntry;
    assert.equal(typeof row.rank, "number");
    assert.equal(typeof row.playerId, "string");
    assert.equal(typeof row.username, "string");
    assert.equal(typeof row.views, "number");
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
  });
}

describe("most viewed routes", { concurrency: 1 }, () => {
  it("defaults to the all-time set and keeps a missing player's rank", async () => {
    const ada = await createPlayer("ada");
    rangeResult = [
      { value: "507f1f77bcf86cd799439011", score: 80 },
      { value: ada._id.toString(), score: 20 },
    ];

    const response = await request();

    assert.equal(response.status, 200);
    assert.deepEqual(asMostViewed(response.json), [
      { rank: 2, playerId: ada._id.toString(), username: "ada", views: 20 },
    ]);
    assert.deepEqual(rangeCalls, [
      { key: VIEWS_ALL_KEY, min: 0, max: 99, REV: true },
    ]);
  });

  it("reads the daily or weekly set", async () => {
    const now = new Date();
    const daily = await request("?timeframe=daily");
    const weekly = await request("?timeframe=weekly");

    assert.equal(daily.status, 200);
    assert.equal(weekly.status, 200);
    assert.deepEqual(rangeCalls, [
      { key: dailyViewsKey(now), min: 0, max: 99, REV: true },
      { key: weeklyViewsKey(now), min: 0, max: 99, REV: true },
    ]);
  });

  it("rejects an unknown timeframe", async () => {
    const response = await request("?timeframe=month");

    assert.equal(response.status, 400);
    assert.equal(asError(response.json), "timeframe must be all, daily, or weekly");
    assert.equal(rangeCalls.length, 0);
  });
});
