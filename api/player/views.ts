import { Player } from "../../models/Player.js";
import { PROFILE_TTL_SEC, profileKey } from "./cache.js";
import {
  DAILY_TTL_SEC,
  VIEWS_ALL_KEY,
  VIEWS_DIRTY_KEY,
  WEEKLY_TTL_SEC,
  dailyViewsKey,
  weeklyViewsKey,
} from "./viewKeys.js";

export const VIEW_FLUSH_INTERVAL_MS = 5000;

export const RECORD_PROFILE_VIEW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return -1
end
local ok, profile = pcall(cjson.decode, raw)
if not ok or type(profile) ~= 'table' then
  return -1
end
local views = tonumber(profile['views']) or 0
views = views + 1
profile['views'] = views
redis.call('SET', KEYS[1], cjson.encode(profile), 'EX', ARGV[1])
redis.call('ZINCRBY', KEYS[2], 1, ARGV[2])
redis.call('ZINCRBY', KEYS[3], 1, ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[3])
redis.call('ZINCRBY', KEYS[4], 1, ARGV[2])
redis.call('EXPIRE', KEYS[4], ARGV[4])
redis.call('SADD', KEYS[5], ARGV[2])
return views
`;

export interface ViewCommandRedis {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  zRem(key: string, member: string): Promise<number>;
  sRem(key: string, member: string): Promise<number>;
  sMembers(key: string): Promise<string[]>;
  zScore(key: string, member: string): Promise<number | null>;
}

function asViewCount(reply: unknown): number | null {
  if (typeof reply === "number" && Number.isFinite(reply) && reply >= 0) {
    return reply;
  }
  if (typeof reply === "string" && reply.trim() !== "") {
    const parsed = Number(reply);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

export async function recordProfileView(
  redis: ViewCommandRedis,
  id: string,
  now = new Date(),
): Promise<number | null> {
  const reply = await redis.eval(RECORD_PROFILE_VIEW_SCRIPT, {
    keys: [
      profileKey(id),
      VIEWS_ALL_KEY,
      dailyViewsKey(now),
      weeklyViewsKey(now),
      VIEWS_DIRTY_KEY,
    ],
    arguments: [
      String(PROFILE_TTL_SEC),
      id,
      String(DAILY_TTL_SEC),
      String(WEEKLY_TTL_SEC),
    ],
  });
  return asViewCount(reply);
}

export async function removeProfileViews(
  redis: ViewCommandRedis,
  id: string,
  now = new Date(),
): Promise<void> {
  await Promise.all([
    redis.zRem(VIEWS_ALL_KEY, id),
    redis.zRem(dailyViewsKey(now), id),
    redis.zRem(weeklyViewsKey(now), id),
    redis.sRem(VIEWS_DIRTY_KEY, id),
  ]);
}

export async function flushViewCounts(redis: ViewCommandRedis): Promise<void> {
  const ids = await redis.sMembers(VIEWS_DIRTY_KEY);
  if (ids.length === 0) {
    return;
  }

  const scores = await Promise.all(
    ids.map((id) => redis.zScore(VIEWS_ALL_KEY, id)),
  );
  const updates = ids.flatMap((id, index) => {
    const score = scores[index];
    if (score === null || score === undefined) {
      return [];
    }
    return [
      {
        updateOne: {
          filter: { _id: id },
          update: { $set: { views: score } },
        },
      },
    ];
  });

  if (updates.length > 0) {
    await Player.bulkWrite(updates);
  }

  await Promise.all(
    ids.map(async (id, index) => {
      const written = scores[index];
      if (written === null || written === undefined) {
        await redis.sRem(VIEWS_DIRTY_KEY, id);
        return;
      }
      const current = await redis.zScore(VIEWS_ALL_KEY, id);
      if (current === written) {
        await redis.sRem(VIEWS_DIRTY_KEY, id);
      }
    }),
  );
}

export function startViewCountFlush(
  redis: ViewCommandRedis,
  intervalMs = VIEW_FLUSH_INTERVAL_MS,
): () => Promise<void> {
  let flushing = false;
  const timer = setInterval(() => {
    if (flushing) {
      return;
    }
    flushing = true;
    void flushViewCounts(redis)
      .catch((err: unknown) => {
        console.error("View count flush failed:", err);
      })
      .finally(() => {
        flushing = false;
      });
  }, intervalMs);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await flushViewCounts(redis);
  };
}
