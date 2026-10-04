import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  createRateLimiter,
  type RateLimiterOptions,
} from "../middleware/rateLimiter.js";

interface ExpireCall {
  key: string;
  seconds: number;
}

function createRedis(options?: { fail?: boolean; ttl?: number }) {
  const counts = new Map<string, number>();
  const expireCalls: ExpireCall[] = [];
  const ttl = options?.ttl ?? 42;

  return {
    expireCalls,
    async incr(key: string): Promise<number> {
      if (options?.fail) {
        throw new Error("redis down");
      }
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire(key: string, seconds: number): Promise<number> {
      expireCalls.push({ key, seconds });
      return 1;
    },
    async ttl(): Promise<number> {
      return ttl;
    },
  };
}

async function listen(handler: RequestHandler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(handler);
  app.get("/", (_req, res) => {
    res.json({ ok: true });
  });

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function invoke(
  handler: RequestHandler,
  req: Partial<Request> & { headers?: Request["headers"] },
) {
  const headers = new Map<string, number | string>();
  let statusCode = 200;
  let body: unknown;
  let nextCalled = false;

  const res = {
    setHeader(name: string, value: number | string) {
      headers.set(name, value);
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };

  await handler(
    { headers: {}, ...req } as Request,
    res as unknown as Response,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );

  return { statusCode, headers, body, nextCalled };
}

const options: RateLimiterOptions = { windowSec: 60, maxRequests: 2 };

describe("createRateLimiter", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("allows requests up to the limit and expires the key once", async () => {
    const redis = createRedis();
    const server = await listen(createRateLimiter(redis, options));

    try {
      const before = Math.floor(Date.now() / 1000) + 42;
      const first = await fetch(server.url);
      const second = await fetch(server.url);
      const after = Math.floor(Date.now() / 1000) + 42;

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(await first.json(), { ok: true });
      assert.equal(first.headers.get("x-ratelimit-limit"), "2");
      assert.equal(first.headers.get("x-ratelimit-remaining"), "1");
      assert.equal(second.headers.get("x-ratelimit-remaining"), "0");

      const reset = Number(first.headers.get("x-ratelimit-reset"));
      assert.ok(reset >= before && reset <= after);
      assert.deepEqual(redis.expireCalls, [
        { key: "ratelimit:127.0.0.1", seconds: 60 },
      ]);
    } finally {
      await server.close();
    }
  });

  it("returns 429 once the limit is exceeded", async () => {
    const redis = createRedis({ ttl: 17 });
    const server = await listen(
      createRateLimiter(redis, { windowSec: 30, maxRequests: 1 }),
    );

    try {
      const allowed = await fetch(server.url);
      const blocked = await fetch(server.url);

      assert.equal(allowed.status, 200);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("x-ratelimit-remaining"), "0");
      assert.deepEqual(await blocked.json(), {
        error: "Too Many Requests",
        retryAfterSeconds: 17,
      });
      assert.equal(redis.expireCalls.length, 1);
    } finally {
      await server.close();
    }
  });

  it("fails open when redis throws", async () => {
    const error = mock.method(console, "error", () => {});
    const redis = createRedis({ fail: true });
    const server = await listen(createRateLimiter(redis, options));

    try {
      const response = await fetch(server.url);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(error.mock.calls.length, 1);
      assert.equal(redis.expireCalls.length, 0);
    } finally {
      await server.close();
    }
  });

  it("counts each client ip separately", async () => {
    const redis = createRedis();
    const limiter = createRateLimiter(redis, { windowSec: 15, maxRequests: 1 });

    const first = await invoke(limiter, { ip: "10.0.0.1" });
    const second = await invoke(limiter, { ip: "10.0.0.2" });
    const blocked = await invoke(limiter, { ip: "10.0.0.1" });

    assert.equal(first.nextCalled, true);
    assert.equal(second.nextCalled, true);
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(
      redis.expireCalls.map((call) => call.key),
      ["ratelimit:10.0.0.1", "ratelimit:10.0.0.2"],
    );
  });

  it("falls back to the forwarded address when req.ip is missing", async () => {
    const redis = createRedis();
    const limiter = createRateLimiter(redis, options);

    await invoke(limiter, {
      headers: { "x-forwarded-for": ["203.0.113.5", "10.0.0.9"] },
    });
    await invoke(limiter, {});

    assert.deepEqual(
      redis.expireCalls.map((call) => call.key),
      ["ratelimit:203.0.113.5", "ratelimit:127.0.0.1"],
    );
  });

  it("keeps each named limit on its own counter", async () => {
    const redis = createRedis();
    const reads = createRateLimiter(redis, {
      windowSec: 60,
      maxRequests: 60,
      name: "read",
    });
    const scores = createRateLimiter(redis, {
      windowSec: 60,
      maxRequests: 1,
      name: "score",
    });

    const read = await invoke(reads, { ip: "10.0.0.1" });
    const score = await invoke(scores, { ip: "10.0.0.1" });
    const blockedScore = await invoke(scores, { ip: "10.0.0.1" });
    const anotherRead = await invoke(reads, { ip: "10.0.0.1" });

    assert.equal(read.nextCalled, true);
    assert.equal(score.nextCalled, true);
    assert.equal(blockedScore.nextCalled, false);
    assert.equal(blockedScore.statusCode, 429);
    assert.equal(anotherRead.nextCalled, true);
    assert.deepEqual(
      redis.expireCalls.map((call) => call.key),
      ["ratelimit:read:10.0.0.1", "ratelimit:score:10.0.0.1"],
    );
  });

  it("limits the mounted routes without sharing a budget", async () => {
    const redis = createRedis({ ttl: 9 });
    const readLimiter = createRateLimiter(redis, {
      windowSec: 60,
      maxRequests: 1,
      name: "read",
    });
    const scoreLimiter = createRateLimiter(redis, {
      windowSec: 60,
      maxRequests: 1,
      name: "score",
    });
    const createAccountLimiter = createRateLimiter(redis, {
      windowSec: 3600,
      maxRequests: 1,
      name: "create-account",
    });

    const playerRouter = Router();
    playerRouter.post("/", (_req, res) => {
      res.status(201).json({ created: true });
    });
    playerRouter.get("/", (_req, res) => {
      res.json({ players: [] });
    });

    const app = express();
    app.post("/api/player", createAccountLimiter);
    app.post("/api/scores", scoreLimiter);
    app.get("/api/players/:id/rank", readLimiter);
    app.get("/api/leaderboard", readLimiter);
    app.use("/api/player", playerRouter);
    app.post("/api/scores", (_req, res) => {
      res.status(201).json({ scored: true });
    });
    app.get("/api/players/:id/rank", (_req, res) => {
      res.json({ rank: 1 });
    });
    app.get("/api/leaderboard", (_req, res) => {
      res.json([]);
    });

    const server: Server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const created = await fetch(`${baseUrl}/api/player`, { method: "POST" });
      const blockedCreate = await fetch(`${baseUrl}/api/player`, {
        method: "POST",
      });
      const players = await fetch(`${baseUrl}/api/player`);
      const scored = await fetch(`${baseUrl}/api/scores`, { method: "POST" });
      const leaderboard = await fetch(`${baseUrl}/api/leaderboard`);
      const blockedRank = await fetch(
        `${baseUrl}/api/players/507f1f77bcf86cd799439011/rank`,
      );

      assert.equal(created.status, 201);
      assert.equal(blockedCreate.status, 429);
      assert.equal(players.status, 200);
      assert.equal(scored.status, 201);
      assert.equal(leaderboard.status, 200);
      assert.equal(blockedRank.status, 429);
      assert.deepEqual(await blockedRank.json(), {
        error: "Too Many Requests",
        retryAfterSeconds: 9,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
