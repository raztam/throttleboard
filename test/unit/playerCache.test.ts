import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPlayerProfiles,
  invalidatePlayerProfile,
  profileKey,
  type ProfileCacheRedis,
} from "../../api/player/cache.js";
import { Player } from "../../models/Player.js";

const PROFILE_TTL_SEC = 3600;

interface SetCall {
  key: string;
  value: string;
  ex: number;
}

function createRedis() {
  const store = new Map<string, string>();
  const mGetCalls: string[][] = [];
  const setCalls: SetCall[] = [];
  const deletedKeys: string[] = [];
  const flags = { read: false, write: false, del: false };

  const redis: ProfileCacheRedis = {
    async mGet(keys) {
      mGetCalls.push(keys);
      if (flags.read) {
        throw new Error("cache read down");
      }
      return keys.map((key) => store.get(key) ?? null);
    },
    async set(key, value, options) {
      if (flags.write) {
        throw new Error("cache write down");
      }
      store.set(key, value);
      setCalls.push({ key, value, ex: options.EX });
      return "OK";
    },
    async del(key) {
      deletedKeys.push(key);
      if (flags.del) {
        throw new Error("cache delete down");
      }
      store.delete(key);
      return 1;
    },
  };

  return { redis, store, mGetCalls, setCalls, deletedKeys, flags };
}

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  await mongo.stop();
});

beforeEach(async () => {
  await Player.deleteMany({});
});

describe("player profile cache", () => {
  it("builds the profile key", () => {
    expect(profileKey("abc")).toBe("player:profile:abc");
  });

  it("loads missing profiles in one query and stores them", async () => {
    const ada = await Player.create({
      username: "ada",
      email: "ada@example.com",
    });
    const grace = await Player.create({
      username: "grace",
      email: "grace@example.com",
    });
    const cache = createRedis();

    const profiles = await getPlayerProfiles(cache.redis, [
      ada.id,
      grace.id,
      ada.id,
    ]);

    expect(cache.mGetCalls).toEqual([
      [profileKey(ada.id), profileKey(grace.id)],
    ]);
    expect(profiles.get(ada.id)?.username).toBe("ada");
    expect(profiles.get(grace.id)?.username).toBe("grace");
    expect(cache.setCalls.map((call) => ({ key: call.key, ex: call.ex }))).toEqual(
      expect.arrayContaining([
        { key: profileKey(ada.id), ex: PROFILE_TTL_SEC },
        { key: profileKey(grace.id), ex: PROFILE_TTL_SEC },
      ]),
    );
    expect(cache.setCalls).toHaveLength(2);
  });

  it("treats invalid cache JSON as a miss", async () => {
    const ada = await Player.create({
      username: "ada",
      email: "ada@example.com",
    });
    const cache = createRedis();
    cache.store.set(profileKey(ada.id), "not-json");

    const profiles = await getPlayerProfiles(cache.redis, [ada.id]);

    expect(profiles.get(ada.id)?.username).toBe("ada");
    expect(cache.setCalls).toHaveLength(1);
    expect(cache.store.get(profileKey(ada.id))).toContain("\"username\":\"ada\"");
  });

  it("returns a cached profile without reading MongoDB again", async () => {
    const ada = await Player.create({
      username: "ada",
      email: "ada@example.com",
    });
    const cache = createRedis();
    await getPlayerProfiles(cache.redis, [ada.id]);
    await Player.deleteOne({ _id: ada._id });

    const profiles = await getPlayerProfiles(cache.redis, [ada.id]);

    expect(profiles.get(ada.id)?.username).toBe("ada");
    expect(cache.setCalls).toHaveLength(1);
  });

  it("falls back to MongoDB when the cache read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ada = await Player.create({
      username: "ada",
      email: "ada@example.com",
    });
    const cache = createRedis();
    cache.flags.read = true;

    const profiles = await getPlayerProfiles(cache.redis, [ada.id]);

    expect(profiles.get(ada.id)?.username).toBe("ada");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("deletes the profile key", async () => {
    const cache = createRedis();
    cache.store.set(profileKey("abc"), "{}");

    await invalidatePlayerProfile(cache.redis, "abc");

    expect(cache.deletedKeys).toEqual([profileKey("abc")]);
    expect(cache.store.has(profileKey("abc"))).toBe(false);
  });

  it("logs a failed delete and still resolves", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = createRedis();
    cache.flags.del = true;

    await expect(invalidatePlayerProfile(cache.redis, "abc")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
