import express, {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  type RateLimiterOptions,
} from "../../middleware/rateLimiter.js";

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

function appWith(handler: RequestHandler) {
  const app = express();
  app.use(handler);
  app.get("/", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
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
    vi.restoreAllMocks();
  });

  it("allows requests up to the limit and expires the key once", async () => {
    const redis = createRedis();
    const app = appWith(createRateLimiter(redis, options));
    const before = Math.floor(Date.now() / 1000) + 42;

    const first = await request(app).get("/");
    const second = await request(app).get("/");
    const after = Math.floor(Date.now() / 1000) + 42;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");
    const reset = Number(first.headers["x-ratelimit-reset"]);
    expect(reset).toBeGreaterThanOrEqual(before);
    expect(reset).toBeLessThanOrEqual(after);
    expect(redis.expireCalls).toEqual([
      { key: "ratelimit:127.0.0.1", seconds: 60 },
    ]);
  });

  it("returns 429 once the limit is exceeded", async () => {
    const redis = createRedis({ ttl: 17 });
    const app = appWith(
      createRateLimiter(redis, { windowSec: 30, maxRequests: 1 }),
    );

    const allowed = await request(app).get("/");
    const blocked = await request(app).get("/");

    expect(allowed.status).toBe(200);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.body).toEqual({
      error: "Too Many Requests",
      retryAfterSeconds: 17,
    });
    expect(redis.expireCalls).toHaveLength(1);
  });

  it("fails open when redis throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const redis = createRedis({ fail: true });
    const app = appWith(createRateLimiter(redis, options));

    const response = await request(app).get("/");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(error).toHaveBeenCalledOnce();
    expect(redis.expireCalls).toHaveLength(0);
  });

  it("counts each client ip separately", async () => {
    const redis = createRedis();
    const limiter = createRateLimiter(redis, { windowSec: 15, maxRequests: 1 });

    const first = await invoke(limiter, { ip: "10.0.0.1" });
    const second = await invoke(limiter, { ip: "10.0.0.2" });
    const blocked = await invoke(limiter, { ip: "10.0.0.1" });

    expect(first.nextCalled).toBe(true);
    expect(second.nextCalled).toBe(true);
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.statusCode).toBe(429);
    expect(redis.expireCalls.map((call) => call.key)).toEqual([
      "ratelimit:10.0.0.1",
      "ratelimit:10.0.0.2",
    ]);
  });

  it("falls back to the forwarded address when req.ip is missing", async () => {
    const redis = createRedis();
    const limiter = createRateLimiter(redis, options);

    await invoke(limiter, {
      headers: { "x-forwarded-for": ["203.0.113.5", "10.0.0.9"] },
    });
    await invoke(limiter, {});

    expect(redis.expireCalls.map((call) => call.key)).toEqual([
      "ratelimit:203.0.113.5",
      "ratelimit:127.0.0.1",
    ]);
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

    expect(read.nextCalled).toBe(true);
    expect(score.nextCalled).toBe(true);
    expect(blockedScore.nextCalled).toBe(false);
    expect(blockedScore.statusCode).toBe(429);
    expect(anotherRead.nextCalled).toBe(true);
    expect(redis.expireCalls.map((call) => call.key)).toEqual([
      "ratelimit:read:10.0.0.1",
      "ratelimit:score:10.0.0.1",
    ]);
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

    const created = await request(app).post("/api/player");
    const blockedCreate = await request(app).post("/api/player");
    const players = await request(app).get("/api/player");
    const scored = await request(app).post("/api/scores");
    const leaderboard = await request(app).get("/api/leaderboard");
    const blockedRank = await request(app).get(
      "/api/players/507f1f77bcf86cd799439011/rank",
    );

    expect(created.status).toBe(201);
    expect(blockedCreate.status).toBe(429);
    expect(players.status).toBe(200);
    expect(scored.status).toBe(201);
    expect(leaderboard.status).toBe(200);
    expect(blockedRank.status).toBe(429);
    expect(blockedRank.body).toEqual({
      error: "Too Many Requests",
      retryAfterSeconds: 9,
    });
  });
});
