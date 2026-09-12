import { PUZZLE_SEEDS, type PuzzleSize } from "./puzzle-generator.ts";

export type ChallengeMode = "daily" | "weekly" | "monthly";

export type Challenge = {
  mode: ChallengeMode;
  key: string;
  size: PuzzleSize;
  seed: number;
  title: string;
  periodLabel: string;
};

export const CHALLENGE_MODES: readonly ChallengeMode[] = ["daily", "weekly", "monthly"];

const CHALLENGE_CONFIG: Record<ChallengeMode, { title: string; sizes: readonly PuzzleSize[] }> = {
  daily: { title: "Daily", sizes: [15] },
  weekly: { title: "Weekly", sizes: [20] },
  monthly: { title: "Monthly", sizes: [25] },
};

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
] as const;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function hash(value: string) {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

// Challenges reset at midnight in Thailand. Shifting first lets us keep the
// period calculation UTC-only and deterministic on both server and browser.
function bangkokCalendarDate(now: Date) {
  return new Date(now.getTime() + BANGKOK_OFFSET_MS);
}

function isoWeek(date: Date) {
  const cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() + 4 - day);
  const year = cursor.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((cursor.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { year, week };
}

export function challengePeriodKey(mode: ChallengeMode, now = new Date()) {
  const date = bangkokCalendarDate(now);
  const year = date.getUTCFullYear();
  if (mode === "daily") return `daily-${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (mode === "monthly") return `monthly-${year}-${pad(date.getUTCMonth() + 1)}`;
  const currentWeek = isoWeek(date);
  return `weekly-${currentWeek.year}-W${pad(currentWeek.week)}`;
}

export function challengePeriodLabel(mode: ChallengeMode, now = new Date()) {
  const date = bangkokCalendarDate(now);
  const buddhistYear = date.getUTCFullYear() + 543;
  if (mode === "daily") return `${date.getUTCDate()} ${THAI_MONTHS[date.getUTCMonth()]} ${buddhistYear}`;
  if (mode === "monthly") return `${THAI_MONTHS[date.getUTCMonth()]} ${buddhistYear}`;
  const currentWeek = isoWeek(date);
  return `สัปดาห์ที่ ${currentWeek.week} · ${currentWeek.year + 543}`;
}

export function challengeForMode(mode: ChallengeMode, now = new Date()): Challenge {
  const config = CHALLENGE_CONFIG[mode];
  const key = challengePeriodKey(mode, now);
  const size = config.sizes[hash(`${key}:size`) % config.sizes.length]!;
  const seeds = PUZZLE_SEEDS[size];
  const seed = seeds[hash(`${key}:seed`) % seeds.length]!;
  return { mode, key, size, seed, title: config.title, periodLabel: challengePeriodLabel(mode, now) };
}

export function findCurrentChallenge(size: PuzzleSize, seed: number, now = new Date()) {
  return CHALLENGE_MODES.map((mode) => challengeForMode(mode, now))
    .find((challenge) => challenge.size === size && challenge.seed === seed) ?? null;
}

export function isChallengeMode(value: string | null): value is ChallengeMode {
  return value !== null && CHALLENGE_MODES.includes(value as ChallengeMode);
}
