import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import {
  createPlayerRankRouter,
  type PlayerRankRedis,
} from "../api/players/index.js";

interface RankJson {
  playerId: string;
  rank: number;
  score: number;
}

interface ErrorJson {
  error: string;
}

interface RankCall {
  command: "zRevRank" | "zScore";
  key: string;
  member: string;
}

const PLAYER_ID = "507f1f77bcf86cd799439011";

let server: Server | undefined;
let baseUrl = "";
let rankResult: number | null = null;
let scoreResult: number | null = null;
let calls: RankCall[] = [];
let redisFails = false;

const redis: PlayerRankRedis = {
  async zRevRank(key, member) {
    if (redisFails) {
      throw new Error("redis down");
    }
    calls.push({ command: "zRevRank", key, member });
    return rankResult;
  },
  async zScore(key, member) {
    if (redisFails) {
      throw new Error("redis down");
    }
    calls.push({ command: "zScore", key, member });
    return scoreResult;
  },
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/players", createPlayerRankRouter(redis));
  const listening = app.listen(0, "127.0.0.1");
  server = listening;
  await new Promise<void>((resolve, reject) => {
    listening.once("listening", () => resolve());
    listening.once("error", reject);
  });
  const { port } = listening.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/players`;
});

after(async () => {
  if (server) {
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.closeAllConnections();
      listening.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

beforeEach(() => {
  rankResult = null;
  scoreResult = null;
  calls = [];
  redisFails = false;
});

async function request(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

function asRank(json: unknown): RankJson {
  assert.ok(json && typeof json === "object");
  const body = json as RankJson;
  assert.equal(typeof body.playerId, "string");
  assert.equal(typeof body.rank, "number");
  assert.equal(typeof body.score, "number");
  return body;
}

function asError(json: unknown): string {
  assert.ok(json && typeof json === "object" && "error" in json);
  return (json as ErrorJson).error;
}

describe("player rank route", { concurrency: 1 }, () => {
  it("returns a 1-indexed rank and the redis score", async () => {
    rankResult = 0;
    scoreResult = 42;

    const response = await request(`/${PLAYER_ID}/rank`);

    assert.equal(response.status, 200);
    assert.deepEqual(asRank(response.json), {
      playerId: PLAYER_ID,
      rank: 1,
      score: 42,
    });
    assert.deepEqual(calls, [
      { command: "zRevRank", key: "leaderboard:global", member: PLAYER_ID },
      { command: "zScore", key: "leaderboard:global", member: PLAYER_ID },
    ]);
  });

  it("converts a later redis rank to a 1-indexed rank", async () => {
    rankResult = 4;
    scoreResult = 15;

    const response = await request(`/${PLAYER_ID}/rank`);

    assert.equal(response.status, 200);
    assert.equal(asRank(response.json).rank, 5);
    assert.equal(asRank(response.json).score, 15);
  });

  it("returns 404 when the player has no score", async () => {
    rankResult = null;
    scoreResult = null;

    const response = await request(`/${PLAYER_ID}/rank`);

    assert.equal(response.status, 404);
    assert.equal(asError(response.json), "Player has not registered a score");
  });

  it("returns 400 for an invalid player id", async () => {
    const response = await request("/not-an-id/rank");

    assert.equal(response.status, 400);
    assert.equal(asError(response.json), "Invalid player id");
    assert.equal(calls.length, 0);
  });

  it("returns 500 when redis fails", async () => {
    redisFails = true;

    const response = await request(`/${PLAYER_ID}/rank`);

    assert.equal(response.status, 500);
    assert.equal(asError(response.json), "Internal server error");
  });
});
