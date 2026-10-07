import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { flushViewCounts } from "../api/player/views.js";
import { dailyViewsKey, weeklyViewsKey } from "../api/player/viewKeys.js";
import { Player } from "../models/Player.js";

describe("view leaderboard keys", () => {
  it("names the daily and weekly sets in UTC", () => {
    const date = new Date("2026-10-07T23:30:00.000Z");
    assert.equal(dailyViewsKey(date), "leaderboard:views:daily:2026-10-07");
    assert.equal(weeklyViewsKey(date), "leaderboard:views:weekly:2026-W41");
    assert.equal(
      weeklyViewsKey(new Date("2019-12-30T00:00:00.000Z")),
      "leaderboard:views:weekly:2020-W01",
    );
  });
});

describe("view count flush", { concurrency: 1 }, () => {
  let mongo: MongoMemoryServer | undefined;
  const dirty = new Set<string>();
  const scores = new Map<string, number>();
  let scoreReads: number[] = [];

  const redis = {
    async eval() {
      return null;
    },
    async zRem() {
      return 0;
    },
    async sRem(_key: string, member: string) {
      return dirty.delete(member) ? 1 : 0;
    },
    async sMembers() {
      return [...dirty];
    },
    async zScore(_key: string, member: string) {
      const queued = scoreReads.shift();
      if (queued !== undefined) {
        return queued;
      }
      return scores.get(member) ?? null;
    },
  };

  before(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  }, { timeout: 120_000 });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await mongo?.stop();
  });

  beforeEach(async () => {
    dirty.clear();
    scores.clear();
    scoreReads = [];
    await Player.deleteMany({});
  });

  it("writes the all-time score onto the player and clears the dirty id", async () => {
    const player = await Player.create({
      username: "ada",
      email: "ada@example.com",
    });
    const id = player._id.toString();
    dirty.add(id);
    scores.set(id, 7);

    await flushViewCounts(redis);

    assert.equal((await Player.findById(id))?.views, 7);
    assert.equal(dirty.has(id), false);
  });

  it("leaves the id dirty when the score changes during the flush", async () => {
    const player = await Player.create({
      username: "grace",
      email: "grace@example.com",
    });
    const id = player._id.toString();
    dirty.add(id);
    scoreReads = [5, 6];

    await flushViewCounts(redis);

    assert.equal((await Player.findById(id))?.views, 5);
    assert.equal(dirty.has(id), true);
  });
});
