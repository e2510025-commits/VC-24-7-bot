import { pool } from './db.js';

function toNullableInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

export async function upsertTrackedOsuUser({ discordId, osuUserId = null, osuUsername }) {
  const normalizedDiscordId = String(discordId || '').trim();
  const normalizedUsername = String(osuUsername || '').trim();

  if (!normalizedDiscordId) {
    throw new Error('discordId must be provided');
  }

  if (!normalizedUsername) {
    throw new Error('osuUsername must be provided');
  }

  const result = await pool.query(
    `INSERT INTO osu_tracked_users (
      discord_id,
      osu_user_id,
      osu_username,
      first_linked_at,
      last_linked_at
    )
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (discord_id)
    DO UPDATE SET
      osu_user_id = COALESCE(EXCLUDED.osu_user_id, osu_tracked_users.osu_user_id),
      osu_username = EXCLUDED.osu_username,
      last_linked_at = NOW()
    RETURNING
      discord_id,
      osu_user_id,
      osu_username,
      first_linked_at,
      last_linked_at`,
    [normalizedDiscordId, toNullableInteger(osuUserId), normalizedUsername]
  );

  return result.rows[0];
}

export async function listTrackedOsuUsers() {
  const result = await pool.query(
    `SELECT
      discord_id,
      osu_user_id,
      osu_username,
      first_linked_at,
      last_linked_at
    FROM osu_tracked_users
    ORDER BY last_linked_at DESC`
  );

  return result.rows;
}
