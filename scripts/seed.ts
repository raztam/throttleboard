import "dotenv/config";
import mongoose from "mongoose";
import { createClient } from "redis";
import { Match } from "../models/Match.js";
import { Player } from "../models/Player.js";

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/throttleboard";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const LEADERBOARD_KEY = "leaderboard:global";
const PROFILE_KEY_PATTERN = "player:profile:*";

interface SeedPlayer {
  username: string;
  email: string;
  createdDaysAgo: number;
  /** Match scores, oldest first. The highest becomes the leaderboard score. */
  scores: number[];
}

const SEED_PLAYERS: SeedPlayer[] = [
  {
    username: "apex-nova",
    email: "apex.nova@example.com",
    createdDaysAgo: 40,
    scores: [6400, 9100, 12840],
  },
  {
    username: "drift-king",
    email: "drift.king@example.com",
    createdDaysAgo: 36,
    scores: [7200, 12110, 9800],
  },
  {
    username: "nitro-lane",
    email: "nitro.lane@example.com",
    createdDaysAgo: 33,
    scores: [5100, 11450, 8600],
  },
  {
    username: "velvet-throttle",
    email: "velvet.throttle@example.com",
    createdDaysAgo: 29,
    scores: [4300, 10980],
  },
  {
    username: "redline-rio",
    email: "redline.rio@example.com",
    createdDaysAgo: 25,
    scores: [8800, 10320, 7600, 9400],
  },
  {
    username: "ghost-gear",
    email: "ghost.gear@example.com",
    createdDaysAgo: 22,
    scores: [6100, 9780, 8200],
  },
  {
    username: "midnight-apex",
    email: "midnight.apex@example.com",
    createdDaysAgo: 18,
    scores: [5400, 9340],
  },
  {
    username: "turbo-tess",
    email: "turbo.tess@example.com",
    createdDaysAgo: 16,
    scores: [4700, 8910, 7300],
  },
  {
    username: "canyon-cruz",
    email: "canyon.cruz@example.com",
    createdDaysAgo: 14,
    scores: [3900, 8460, 6100],
  },
  {
    username: "slipstream-sam",
    email: "slipstream.sam@example.com",
    createdDaysAgo: 12,
    scores: [2800, 8020, 6500],
  },
  {
    username: "pit-lane-pia",
    email: "pit.lane.pia@example.com",
    createdDaysAgo: 9,
    scores: [4100, 7590],
  },
  {
    username: "oversteer-otto",
    email: "oversteer.otto@example.com",
    createdDaysAgo: 7,
    scores: [2200, 7010, 5400],
  },
  {
    username: "hairpin-hana",
    email: "hairpin.hana@example.com",
    createdDaysAgo: 5,
    scores: [3600, 6540, 5100],
  },
  {
    username: "grid-lock-lee",
    email: "grid.lock.lee@example.com",
    createdDaysAgo: 3,
    scores: [1900, 5980],
  },
  {
    username: "warm-up-wes",
    email: "warm.up.wes@example.com",
    createdDaysAgo: 1,
    scores: [800, 4120, 2600],
  },
];

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function matchPlayedAt(
  createdDaysAgo: number,
  scoreIndex: number,
  scoreCount: number,
): Date {
  if (scoreCount <= 1) {
    return daysAgo(Math.max(0, createdDaysAgo - 1));
  }
  const offset = Math.round((scoreIndex / (scoreCount - 1)) * createdDaysAgo);
  return daysAgo(createdDaysAgo - offset);
}

function highScore(scores: number[]): number {
  return Math.max(...scores);
}

async function clearProfileCache(
  redis: ReturnType<typeof createClient>,
): Promise<number> {
  const keys: string[] = [];
  for await (const batch of redis.scanIterator({
    MATCH: PROFILE_KEY_PATTERN,
  })) {
    keys.push(...batch);
  }
  if (keys.length === 0) {
    return 0;
  }
  await redis.del(keys);
  return keys.length;
}

async function seed(): Promise<void> {
  const redis = createClient({ url: REDIS_URL });
  redis.on("error", (err: Error) => {
    console.error("Redis client error:", err.message);
  });

  await mongoose.connect(MONGODB_URI);
  await redis.connect();

  try {
    const [removedPlayers, removedMatches] = await Promise.all([
      Player.deleteMany({}),
      Match.deleteMany({}),
    ]);
    await redis.del(LEADERBOARD_KEY);
    const removedProfiles = await clearProfileCache(redis);

    const players = await Player.insertMany(
      SEED_PLAYERS.map((entry) => ({
        username: entry.username,
        email: entry.email,
        highScore: highScore(entry.scores),
        createdAt: daysAgo(entry.createdDaysAgo),
      })),
    );

    const matches = players.flatMap((player, index) => {
      const entry = SEED_PLAYERS[index];
      return entry.scores.map((score, scoreIndex) => ({
        playerId: player._id,
        score,
        playedAt: matchPlayedAt(
          entry.createdDaysAgo,
          scoreIndex,
          entry.scores.length,
        ),
      }));
    });
    await Match.insertMany(matches);

    await redis.zAdd(
      LEADERBOARD_KEY,
      players.map((player) => ({
        score: player.highScore,
        value: player._id.toString(),
      })),
    );

    const ranked = [...players].sort((a, b) => b.highScore - a.highScore);
    const top = ranked[0];

    console.log(
      `Replaced ${removedPlayers.deletedCount} players, ${removedMatches.deletedCount} matches, and ${removedProfiles} cached profiles.`,
    );
    console.log(
      `Seeded ${players.length} players and ${matches.length} matches.`,
    );
    console.log("");
    console.log("Leaderboard:");
    ranked.forEach((player, index) => {
      console.log(
        `  ${String(index + 1).padStart(2, " ")}. ${player.username.padEnd(18, " ")} ${player.highScore}`,
      );
    });
    console.log("");
    console.log("Try:");
    console.log("  curl http://localhost:3000/api/leaderboard");
    console.log("  curl http://localhost:3000/api/player");
    if (top) {
      console.log(`  curl http://localhost:3000/api/player/${top._id.toString()}`);
      console.log(
        `  curl http://localhost:3000/api/players/${top._id.toString()}/rank`,
      );
    }
  } finally {
    if (redis.isOpen) {
      await redis.quit();
    }
    await mongoose.disconnect();
  }
}

seed().catch((err: unknown) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
