import { pool } from './db.js';

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNullableInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function parseScoreIds(jsonText) {
  try {
    const parsed = JSON.parse(String(jsonText || '[]'));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(item => Number(item))
      .filter(Number.isFinite)
      .map(item => Math.trunc(item));
  } catch {
    return [];
  }
}

export async function getLatestTopPlaySnapshot({ osuUserId, mode }) {
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
      top_limit,
      score_ids_json,
      top_pp_sum,
      captured_at
    FROM osu_top_play_snapshots
    WHERE osu_user_id = $1
      AND mode = $2
    ORDER BY captured_at DESC
    LIMIT 1`,
    [Math.trunc(userId), normalizedMode]
  );

  if (!result.rows[0]) {
    return null;
  }

  return {
    ...result.rows[0],
    score_ids: parseScoreIds(result.rows[0].score_ids_json)
  };
}

export async function saveTopPlaySnapshot({
  discordId,
  osuUserId,
  osuUsername,
  mode,
  topLimit,
  scoreIds,
  topPpSum
}) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  const normalizedIds = Array.isArray(scoreIds)
    ? scoreIds
      .map(item => Number(item))
      .filter(Number.isFinite)
      .map(item => Math.trunc(item))
    : [];

  const result = await pool.query(
    `INSERT INTO osu_top_play_snapshots (
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      top_limit,
      score_ids_json,
      top_pp_sum
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id,
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      top_limit,
      score_ids_json,
      top_pp_sum,
      captured_at`,
    [
      discordId ? String(discordId) : null,
      Math.trunc(userId),
      osuUsername ? String(osuUsername) : null,
      normalizedMode,
      Math.max(1, toNullableInteger(topLimit) || 50),
      JSON.stringify(normalizedIds),
      toNullableNumber(topPpSum)
    ]
  );

  return {
    ...result.rows[0],
    score_ids: parseScoreIds(result.rows[0].score_ids_json)
  };
}
