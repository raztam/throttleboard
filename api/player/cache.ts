import { Player } from "../../models/Player.js";

const PROFILE_TTL_SEC = 3600;

export interface PlayerProfile {
  _id: string;
  username: string;
  email: string;
  createdAt: string;
}

export interface ProfileCacheRedis {
  mGet(keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function profileKey(id: string): string {
  return `player:profile:${id}`;
}

function toProfile(player: {
  _id: { toString(): string };
  username: string;
  email: string;
  createdAt: Date;
}): PlayerProfile {
  return {
    _id: player._id.toString(),
    username: player.username,
    email: player.email,
    createdAt: player.createdAt.toISOString(),
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
      typeof record.createdAt !== "string"
    ) {
      return null;
    }
    return {
      _id: record._id,
      username: record.username,
      email: record.email,
      createdAt: record.createdAt,
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
      const profile = toProfile(player);
      profiles.set(profile._id, profile);
      try {
        await redis.set(profileKey(profile._id), JSON.stringify(profile), {
          EX: PROFILE_TTL_SEC,
        });
      } catch (err) {
        console.error("Player profile cache write failed:", err);
      }
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
