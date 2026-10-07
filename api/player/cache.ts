import { Player } from "../../models/Player.js";
import { VIEWS_ALL_KEY } from "./viewKeys.js";

export const PROFILE_TTL_SEC = 3600;

export interface PlayerProfile {
  _id: string;
  username: string;
  email: string;
  createdAt: string;
  views: number;
}

export interface ProfileCacheRedis {
  mGet(keys: string[]): Promise<Array<string | null>>;
  set(
    key: string,
    value: string,
    options: { EX: number; NX?: boolean },
  ): Promise<string | null>;
  del(key: string): Promise<unknown>;
  zScore(key: string, member: string): Promise<number | null>;
}

export function profileKey(id: string): string {
  return `player:profile:${id}`;
}

function toProfile(
  player: {
    _id: { toString(): string };
    username: string;
    email: string;
    createdAt: Date;
  },
  views: number,
): PlayerProfile {
  return {
    _id: player._id.toString(),
    username: player.username,
    email: player.email,
    createdAt: player.createdAt.toISOString(),
    views,
  };
}

function parseProfile(raw: string): PlayerProfile | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record._id !== "string" ||
      typeof record.username !== "string" ||
      typeof record.email !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.views !== "number" ||
      !Number.isFinite(record.views)
    ) {
      return null;
    }
    return {
      _id: record._id,
      username: record.username,
      email: record.email,
      createdAt: record.createdAt,
      views: record.views,
    };
  } catch {
    return null;
  }
}

export async function getPlayerProfiles(
  redis: ProfileCacheRedis,
  ids: string[],
): Promise<Map<string, PlayerProfile>> {
  const unique = [...new Set(ids)];
  const profiles = new Map<string, PlayerProfile>();
  if (unique.length === 0) {
    return profiles;
  }

  let cached: Array<string | null> = unique.map(() => null);
  try {
    cached = await redis.mGet(unique.map(profileKey));
  } catch (err) {
    console.error("Player profile cache read failed:", err);
  }

  const missing: string[] = [];
  unique.forEach((id, index) => {
    const raw = cached[index];
    const profile = raw ? parseProfile(raw) : null;
    if (profile && profile._id === id) {
      profiles.set(id, profile);
      return;
    }
    missing.push(id);
  });

  if (missing.length === 0) {
    return profiles;
  }

  const players = await Player.find({ _id: { $in: missing } });
  await Promise.all(
    players.map(async (player) => {
      const id = player._id.toString();
      let views = 0;
      try {
        views = (await redis.zScore(VIEWS_ALL_KEY, id)) ?? 0;
      } catch (err) {
        console.error("View count read failed:", err);
      }
      const profile = toProfile(player, views);
      try {
        const written = await redis.set(profileKey(id), JSON.stringify(profile), {
          EX: PROFILE_TTL_SEC,
          NX: true,
        });
        if (written === null) {
          const [raw] = await redis.mGet([profileKey(id)]);
          const existing = raw ? parseProfile(raw) : null;
          if (existing && existing._id === id) {
            profiles.set(id, existing);
            return;
          }
          await redis.set(profileKey(id), JSON.stringify(profile), {
            EX: PROFILE_TTL_SEC,
          });
        }
      } catch (err) {
        console.error("Player profile cache write failed:", err);
      }
      profiles.set(id, profile);
    }),
  );

  return profiles;
}

export async function invalidatePlayerProfile(
  redis: ProfileCacheRedis,
  id: string,
): Promise<void> {
  try {
    await redis.del(profileKey(id));
  } catch (err) {
    console.error("Player profile cache delete failed:", err);
  }
}
