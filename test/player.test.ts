import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createPlayerRouter, type PlayerRedis } from "../api/player/index.js";
import {
  VIEWS_ALL_KEY,
  VIEWS_DIRTY_KEY,
  dailyViewsKey,
  weeklyViewsKey,
} from "../api/player/viewKeys.js";
import { Player } from "../models/Player.js";

interface PlayerJson {
  _id: string;
  username: string;
  email: string;
  highScore: number;
  createdAt: string;
}

interface ProfileJson {
  _id: string;
  username: string;
  email: string;
  createdAt: string;
  views: number;
  score: number | null;
  rank: number | null;
}

interface SetCall {
  key: string;
  ex: number;
  nx: boolean;
}

interface ZRemCall {
  key: string;
  member: string;
}

interface ErrorJson {
  error: string;
}

let mongo: MongoMemoryServer | undefined;
let server: Server | undefined;
let baseUrl = "";
const cache = new Map<string, string>();
const scores = new Map<string, number>();
const boards = new Map<string, Map<string, number>>();
const dirty = new Set<string>();
let setCalls: SetCall[] = [];
let deletedKeys: string[] = [];
let zRemCalls: ZRemCall[] = [];
let sRemCalls: ZRemCall[] = [];
let evalCalls = 0;

function board(key: string): Map<string, number> {
  const found = boards.get(key);
  if (found) {
    return found;
  }
  const created = new Map<string, number>();
  boards.set(key, created);
  return created;
}

const redis: PlayerRedis = {
  async mGet(keys) {
    return keys.map((key) => cache.get(key) ?? null);
  },
  async set(key, value, options) {
    if (options.NX && cache.has(key)) {
      return null;
    }
    cache.set(key, value);
    setCalls.push({ key, ex: options.EX, nx: options.NX === true });
    return "OK";
  },
  async del(key) {
    cache.delete(key);
    deletedKeys.push(key);
    return 1;
  },
  async zScore(key, member) {
    if (key === "leaderboard:global") {
      return scores.get(member) ?? null;
    }
    return board(key).get(member) ?? null;
  },
  async zRevRank(_key, member) {
    if (!scores.has(member)) {
      return null;
    }
    const ordered = [...scores.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return ordered.findIndex(([id]) => id === member);
  },
  async zRem(key, member) {
    zRemCalls.push({ key, member });
    if (key === "leaderboard:global") {
      return scores.delete(member) ? 1 : 0;
    }
    return board(key).delete(member) ? 1 : 0;
  },
  async eval(_script, options) {
    evalCalls += 1;
    const profileKey = options.keys[0];
    const id = options.arguments[1];
    if (!profileKey || !id) {
      return -1;
    }
    const raw = cache.get(profileKey);
    if (!raw) {
      return -1;
    }
    const profile = JSON.parse(raw) as { views?: unknown };
    const views = (typeof profile.views === "number" ? profile.views : 0) + 1;
    profile.views = views;
    cache.set(profileKey, JSON.stringify(profile));
    for (const key of options.keys.slice(1, 4)) {
      const scoresForKey = board(key);
      scoresForKey.set(id, (scoresForKey.get(id) ?? 0) + 1);
    }
    dirty.add(id);
    return views;
  },
  async sMembers() {
    return [...dirty];
  },
  async sRem(key, member) {
    sRemCalls.push({ key, member });
    return dirty.delete(member) ? 1 : 0;
  },
};

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Player.createIndexes();

  const app = express();
  app.use(express.json());
  app.use("/api/player", createPlayerRouter(redis));
  const listening = app.listen(0, "127.0.0.1");
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/player`;
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
  cache.clear();
  scores.clear();
  boards.clear();
  dirty.clear();
  setCalls = [];
  deletedKeys = [];
  zRemCalls = [];
  sRemCalls = [];
  evalCalls = 0;
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

function asPlayer(json: unknown): PlayerJson {
  assert.ok(json && typeof json === "object");
  const player = json as PlayerJson;
  assert.equal(typeof player._id, "string");
  assert.equal(typeof player.username, "string");
  assert.equal(typeof player.email, "string");
  assert.equal(typeof player.highScore, "number");
  return player;
}

function asProfile(json: unknown): ProfileJson {
  assert.ok(json && typeof json === "object");
  const profile = json as ProfileJson;
  assert.equal(typeof profile._id, "string");
  assert.equal(typeof profile.username, "string");
  assert.equal(typeof profile.email, "string");
  assert.equal(typeof profile.createdAt, "string");
  assert.equal(typeof profile.views, "number");
  assert.ok(profile.score === null || typeof profile.score === "number");
  assert.ok(profile.rank === null || typeof profile.rank === "number");
  return profile;
}

function asError(json: unknown): string {
  assert.ok(json && typeof json === "object" && "error" in json);
  return (json as ErrorJson).error;
}

async function createPlayer(input?: {
  username?: string;
  email?: string;
  highScore?: number;
}): Promise<PlayerJson> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await request("POST", "", {
    username: input?.username ?? `player-${suffix}`,
    email: input?.email ?? `${suffix}@example.com`,
    ...(input?.highScore !== undefined ? { highScore: input.highScore } : {}),
  });
  assert.equal(response.status, 201);
  return asPlayer(response.json);
}

describe("player routes", { concurrency: 1 }, () => {
  it("creates a player and defaults highScore to 0", async () => {
    const response = await request("POST", "", {
      username: "  Ada  ",
      email: " ada@example.com ",
    });

    assert.equal(response.status, 201);
    const player = asPlayer(response.json);
    assert.equal(player.username, "Ada");
    assert.equal(player.email, "ada@example.com");
    assert.equal(player.highScore, 0);
    assert.ok(player.createdAt);
  });

  it("rejects a create request without username and email", async () => {
    const response = await request("POST", "", {});

    assert.equal(response.status, 400);
    assert.equal(asError(response.json), "username and email are required");
  });

  it("rejects a negative highScore", async () => {
    const response = await request("POST", "", {
      username: "ada",
      email: "ada@example.com",
      highScore: -1,
    });

    assert.equal(response.status, 400);
    assert.equal(asError(response.json), "highScore must be a non-negative number");
  });

  it("rejects a duplicate username or email", async () => {
    await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });

    const username = await request("POST", "", {
      username: "ada",
      email: "other@example.com",
    });
    const email = await request("POST", "", {
      username: "other",
      email: "ada@example.com",
    });

    assert.equal(username.status, 409);
    assert.equal(email.status, 409);
    assert.equal(asError(username.json), "username or email already exists");
  });

  it("lists players newest first", async () => {
    const older = await createPlayer({
      username: "older",
      email: "older@example.com",
    });
    const newer = await createPlayer({
      username: "newer",
      email: "newer@example.com",
    });
    await Player.updateOne(
      { _id: older._id },
      { createdAt: new Date("2020-01-01") },
    );
    await Player.updateOne(
      { _id: newer._id },
      { createdAt: new Date("2024-01-01") },
    );

    const response = await request("GET");

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.json));
    const players = response.json as PlayerJson[];
    assert.deepEqual(
      players.map((player) => player.username),
      ["newer", "older"],
    );
  });

  it("returns a cached profile with the live sorted-set score and rank", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
      highScore: 12,
    });
    scores.set(created._id, 12);

    const response = await request("GET", `/${created._id}`);

    assert.equal(response.status, 200);
    const profile = asProfile(response.json);
    assert.equal(profile.username, "ada");
    assert.equal(profile.email, "ada@example.com");
    assert.equal(profile.score, 12);
    assert.equal(profile.rank, 1);
    assert.deepEqual(setCalls, [
      { key: `player:profile:${created._id}`, ex: 3600, nx: true },
    ]);

    await Player.deleteOne({ _id: created._id });
    const cached = await request("GET", `/${created._id}`);

    assert.equal(cached.status, 200);
    assert.equal(asProfile(cached.json).username, "ada");
    assert.equal(setCalls.length, 1);
  });

  it("increments views in the profile cache and the three leaderboards", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });
    const now = new Date();

    const first = await request("GET", `/${created._id}`);
    const second = await request("GET", `/${created._id}`);

    assert.equal(asProfile(first.json).views, 1);
    assert.equal(asProfile(second.json).views, 2);
    assert.equal(board(VIEWS_ALL_KEY).get(created._id), 2);
    assert.equal(board(dailyViewsKey(now)).get(created._id), 2);
    assert.equal(board(weeklyViewsKey(now)).get(created._id), 2);
    assert.equal(dirty.has(created._id), true);
    assert.equal(evalCalls, 2);
  });

  it("seeds a cache miss from the all-time view score", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });
    board(VIEWS_ALL_KEY).set(created._id, 4);

    const response = await request("GET", `/${created._id}`);

    assert.equal(asProfile(response.json).views, 5);
    assert.equal(board(VIEWS_ALL_KEY).get(created._id), 5);
  });

  it("does not count a missing profile", async () => {
    const missing = await request("GET", "/507f1f77bcf86cd799439011");

    assert.equal(missing.status, 404);
    assert.equal(evalCalls, 0);
    assert.equal(dirty.size, 0);
  });

  it("returns null score and rank when the player is unranked", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });

    const response = await request("GET", `/${created._id}`);

    assert.equal(response.status, 200);
    const profile = asProfile(response.json);
    assert.equal(profile.score, null);
    assert.equal(profile.rank, null);
  });

  it("returns 404 for an unknown player and 400 for a bad id", async () => {
    const missing = await request("GET", "/507f1f77bcf86cd799439011");
    const invalid = await request("GET", "/not-an-id");

    assert.equal(missing.status, 404);
    assert.equal(asError(missing.json), "Player not found");
    assert.equal(invalid.status, 400);
    assert.equal(asError(invalid.json), "Invalid player id");
  });

  it("updates only the provided fields", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
      highScore: 1,
    });

    const response = await request("PATCH", `/${created._id}`, {
      highScore: 40,
    });

    assert.equal(response.status, 200);
    const player = asPlayer(response.json);
    assert.equal(player.highScore, 40);
    assert.equal(player.username, "ada");
    assert.equal(player.email, "ada@example.com");
    assert.deepEqual(deletedKeys, [`player:profile:${created._id}`]);
  });

  it("reloads the profile after a username change", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });
    await request("GET", `/${created._id}`);

    const updated = await request("PATCH", `/${created._id}`, {
      username: "grace",
    });
    const again = await request("GET", `/${created._id}`);

    assert.equal(updated.status, 200);
    assert.equal(asPlayer(updated.json).username, "grace");
    assert.deepEqual(deletedKeys, [`player:profile:${created._id}`]);
    assert.equal(asProfile(again.json).username, "grace");
    assert.equal(setCalls.length, 2);
  });

  it("rejects an empty update and a duplicate email", async () => {
    const ada = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });
    await createPlayer({
      username: "grace",
      email: "grace@example.com",
    });

    const empty = await request("PATCH", `/${ada._id}`, {});
    const duplicate = await request("PATCH", `/${ada._id}`, {
      email: "grace@example.com",
    });

    assert.equal(empty.status, 400);
    assert.equal(asError(empty.json), "No player fields to update");
    assert.equal(duplicate.status, 409);
    assert.equal(asError(duplicate.json), "username or email already exists");
  });

  it("deletes a player", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
    });

    scores.set(created._id, 9);
    await request("GET", `/${created._id}`);

    const removed = await request("DELETE", `/${created._id}`);
    const missing = await request("GET", `/${created._id}`);
    const missingDelete = await request("DELETE", `/${created._id}`);

    assert.equal(removed.status, 204);
    assert.equal(removed.json, null);
    assert.deepEqual(deletedKeys, [`player:profile:${created._id}`]);
    const now = new Date();
    assert.deepEqual(zRemCalls, [
      { key: "leaderboard:global", member: created._id },
      { key: VIEWS_ALL_KEY, member: created._id },
      { key: dailyViewsKey(now), member: created._id },
      { key: weeklyViewsKey(now), member: created._id },
    ]);
    assert.deepEqual(sRemCalls, [
      { key: VIEWS_DIRTY_KEY, member: created._id },
    ]);
    assert.equal(scores.has(created._id), false);
    assert.equal(board(VIEWS_ALL_KEY).has(created._id), false);
    assert.equal(missing.status, 404);
    assert.equal(missingDelete.status, 404);
    assert.equal(zRemCalls.length, 4);
  });
});
