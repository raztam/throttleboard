import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { playerRouter } from "../api/player/index.js";
import { Player } from "../models/Player.js";

interface PlayerJson {
  _id: string;
  username: string;
  email: string;
  highScore: number;
  createdAt: string;
}

interface ErrorJson {
  error: string;
}

let mongo: MongoMemoryServer | undefined;
let server: Server | undefined;
let baseUrl = "";

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Player.createIndexes();

  const app = express();
  app.use(express.json());
  app.use("/api/player", playerRouter);
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

  it("returns one player by id", async () => {
    const created = await createPlayer({
      username: "ada",
      email: "ada@example.com",
      highScore: 12,
    });

    const response = await request("GET", `/${created._id}`);

    assert.equal(response.status, 200);
    assert.equal(asPlayer(response.json).highScore, 12);
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

    const removed = await request("DELETE", `/${created._id}`);
    const missing = await request("GET", `/${created._id}`);
    const missingDelete = await request("DELETE", `/${created._id}`);

    assert.equal(removed.status, 204);
    assert.equal(removed.json, null);
    assert.equal(missing.status, 404);
    assert.equal(missingDelete.status, 404);
  });
});
