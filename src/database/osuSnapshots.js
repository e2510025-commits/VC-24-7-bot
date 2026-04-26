import { pool } from './db.js';

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNullableInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

export async function saveOsuSnapshot({
  osuUserId,
  mode,
  pp,
  globalRank,
  countryRank,
  playTimeSeconds,
  playCount
}) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  await pool.query(
    `INSERT INTO osu_user_snapshots (
      osu_user_id,
      mode,
      pp,
      global_rank,
      country_rank,
      play_time_seconds,
      play_count
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      Math.trunc(userId),
      normalizedMode,
      toNullableNumber(pp),
      toNullableInteger(globalRank),
      toNullableInteger(countryRank),
      toNullableInteger(playTimeSeconds),
      toNullableInteger(playCount)
    ]
  );
}

export async function getClosestSnapshotBefore({ osuUserId, mode, beforeDate }) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';
  const targetDate = beforeDate instanceof Date ? beforeDate : new Date(beforeDate);

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  if (!Number.isFinite(targetDate.getTime())) {
    throw new Error('beforeDate must be a valid date');
  }

  const result = await pool.query(
    `SELECT
      osu_user_id,
      mode,
      pp,
      global_rank,
      country_rank,
      play_time_seconds,
      play_count,
      captured_at
    FROM osu_user_snapshots
    WHERE osu_user_id = $1
      AND mode = $2
      AND captured_at <= $3
    ORDER BY captured_at DESC
    LIMIT 1`,
    [Math.trunc(userId), normalizedMode, targetDate.toISOString()]
  );

  return result.rows[0] || null;
}
