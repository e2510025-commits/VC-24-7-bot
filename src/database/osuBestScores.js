import { pool } from './db.js';

function toNullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toNullableInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

export async function getBestScoreRecord(osuUserId, mode = 'osu') {
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
      score_id,
      pp,
      beatmap_id,
      beatmap_title,
      accuracy,
      miss_count,
      max_combo,
      mods,
      recorded_at
    FROM osu_best_scores
    WHERE osu_user_id = $1
      AND mode = $2
    LIMIT 1`,
    [Math.trunc(userId), normalizedMode]
  );

  return result.rows[0] || null;
}

export async function upsertBestScoreRecord({
  discordId,
  osuUserId,
  osuUsername,
  mode,
  scoreId,
  pp,
  beatmapId,
  beatmapTitle,
  accuracy,
  missCount,
  maxCombo,
  mods
}) {
  const userId = Number(osuUserId);
  const normalizedMode = String(mode || 'osu').trim().toLowerCase() || 'osu';

  if (!Number.isFinite(userId)) {
    throw new Error('osuUserId must be a valid number');
  }

  const result = await pool.query(
    `INSERT INTO osu_best_scores (
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      score_id,
      pp,
      beatmap_id,
      beatmap_title,
      accuracy,
      miss_count,
      max_combo,
      mods,
      recorded_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (osu_user_id, mode)
    DO UPDATE SET
      discord_id = EXCLUDED.discord_id,
      osu_username = EXCLUDED.osu_username,
      score_id = EXCLUDED.score_id,
      pp = EXCLUDED.pp,
      beatmap_id = EXCLUDED.beatmap_id,
      beatmap_title = EXCLUDED.beatmap_title,
      accuracy = EXCLUDED.accuracy,
      miss_count = EXCLUDED.miss_count,
      max_combo = EXCLUDED.max_combo,
      mods = EXCLUDED.mods,
      recorded_at = NOW()
    RETURNING
      id,
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      score_id,
      pp,
      beatmap_id,
      beatmap_title,
      accuracy,
      miss_count,
      max_combo,
      mods,
      recorded_at`,
    [
      discordId ? String(discordId) : null,
      Math.trunc(userId),
      String(osuUsername || ''),
      normalizedMode,
      toNullableInteger(scoreId),
      toNullableNumber(pp),
      toNullableInteger(beatmapId),
      beatmapTitle ? String(beatmapTitle).slice(0, 512) : null,
      toNullableNumber(accuracy),
      toNullableInteger(missCount),
      toNullableInteger(maxCombo),
      mods ? String(mods).slice(0, 128) : null
    ]
  );

  return result.rows[0];
}
