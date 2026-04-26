import { pool } from './db.js';

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNullableInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

export async function insertBestScoreEvent({
  discordId,
  osuUserId,
  osuUsername,
  mode,
  scoreId,
  pp,
  recordedAt = new Date()
}) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';
  const captured = recordedAt instanceof Date ? recordedAt : new Date(recordedAt);

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  await pool.query(
    `INSERT INTO osu_best_score_events (
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      score_id,
      pp,
      recorded_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      discordId ? String(discordId) : null,
      Math.trunc(userId),
      String(osuUsername || ''),
      normalizedMode,
      toNullableInteger(scoreId),
      toNullableNumber(pp),
      Number.isFinite(captured.getTime()) ? captured.toISOString() : new Date().toISOString()
    ]
  );
}

export async function listBestScoreEventsSince({ osuUserId, mode, sinceDate, limit = 1000 }) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';
  const since = sinceDate instanceof Date ? sinceDate : new Date(sinceDate);
  const max = Math.min(2000, Math.max(1, Number(limit) || 1000));

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  if (!Number.isFinite(since.getTime())) {
    throw new Error('sinceDate must be a valid date');
  }

  const result = await pool.query(
    `SELECT
      id,
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      score_id,
      pp,
      recorded_at
    FROM osu_best_score_events
    WHERE osu_user_id = $1
      AND mode = $2
      AND recorded_at >= $3
    ORDER BY recorded_at ASC
    LIMIT $4`,
    [Math.trunc(userId), normalizedMode, since.toISOString(), max]
  );

  return result.rows;
}
