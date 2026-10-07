export const VIEWS_ALL_KEY = "leaderboard:views";
export const VIEWS_DIRTY_KEY = "leaderboard:views:dirty";
export const DAILY_TTL_SEC = 2 * 24 * 60 * 60;
export const WEEKLY_TTL_SEC = 14 * 24 * 60 * 60;

export type ViewTimeframe = "all" | "daily" | "weekly";

export function dailyViewsKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `leaderboard:views:daily:${year}-${month}-${day}`;
}

export function weeklyViewsKey(date: Date): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `leaderboard:views:weekly:${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function viewsLeaderboardKey(
  timeframe: ViewTimeframe,
  now = new Date(),
): string {
  if (timeframe === "daily") {
    return dailyViewsKey(now);
  }
  if (timeframe === "weekly") {
    return weeklyViewsKey(now);
  }
  return VIEWS_ALL_KEY;
}
