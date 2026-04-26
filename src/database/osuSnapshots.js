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
  discordId,
  osuUserId,
  osuUsername,
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
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      pp,
      global_rank,
      country_rank,
      play_time_seconds,
      play_count
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      discordId ? String(discordId) : null,
      Math.trunc(userId),
      osuUsername ? String(osuUsername) : null,
      normalizedMode,
      toNullableNumber(pp),
      toNullableInteger(globalRank),
      toNullableInteger(countryRank),
      toNullableInteger(playTimeSeconds),
      toNullableInteger(playCount)
    ]
  );
}

export async function getLatestSnapshot({ osuUserId, mode }) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  const result = await pool.query(
    `SELECT
      id,
      discord_id,
      osu_user_id,
      osu_username,
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
    ORDER BY captured_at DESC
    LIMIT 1`,
    [Math.trunc(userId), normalizedMode]
  );

  return result.rows[0] || null;
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
      id,
      discord_id,
      osu_user_id,
      osu_username,
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

export async function getSnapshotsSince({ osuUserId, mode, sinceDate, untilDate = new Date() }) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';
  const from = sinceDate instanceof Date ? sinceDate : new Date(sinceDate);
  const to = untilDate instanceof Date ? untilDate : new Date(untilDate);

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    throw new Error('sinceDate/untilDate must be valid dates');
  }

  const result = await pool.query(
    `SELECT
      id,
      discord_id,
      osu_user_id,
      osu_username,
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
      AND captured_at >= $3
      AND captured_at <= $4
    ORDER BY captured_at ASC`,
    [Math.trunc(userId), normalizedMode, from.toISOString(), to.toISOString()]
  );

  return result.rows;
}

export async function getLatestSnapshotsByDiscordIds({ discordIds, mode }) {
  const ids = Array.isArray(discordIds)
    ? discordIds.map(id => String(id || '').trim()).filter(Boolean)
    : [];
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';

  if (ids.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT DISTINCT ON (discord_id)
      id,
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      pp,
      global_rank,
      country_rank,
      play_time_seconds,
      play_count,
      captured_at
    FROM osu_user_snapshots
    WHERE mode = $1
      AND discord_id = ANY($2)
    ORDER BY discord_id, captured_at DESC`,
    [normalizedMode, ids]
  );

  return result.rows;
}
