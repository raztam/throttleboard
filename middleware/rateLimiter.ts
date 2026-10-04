import type { RequestHandler } from "express";

export interface RateLimiterOptions {
  windowSec: number;
  maxRequests: number;
  name?: string;
}

interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  ttl(key: string): Promise<number>;
}

const defaultOptions: RateLimiterOptions = {
  windowSec: 60,
  maxRequests: 10,
};

export function createRateLimiter(
  redisClient: RateLimitRedis,
  options: RateLimiterOptions = defaultOptions,
): RequestHandler {
  return async (req, res, next) => {
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = req.ip || forwardedIp || "127.0.0.1";
    const key = options.name
      ? `ratelimit:${options.name}:${ip}`
      : `ratelimit:${ip}`;

    try {
      const requests = await redisClient.incr(key);

      if (requests === 1) {
        await redisClient.expire(key, options.windowSec);
      }

      const ttl = await redisClient.ttl(key);

      res.setHeader("X-RateLimit-Limit", options.maxRequests);
      res.setHeader(
        "X-RateLimit-Remaining",
        Math.max(0, options.maxRequests - requests),
      );
      res.setHeader("X-RateLimit-Reset", Math.floor(Date.now() / 1000) + ttl);

      if (requests > options.maxRequests) {
        res.status(429).json({
          error: "Too Many Requests",
          retryAfterSeconds: ttl,
        });
        return;
      }

      next();
    } catch (err) {
      console.error("Rate limiter error, failing open:", err);
      next();
    }
  };
}
