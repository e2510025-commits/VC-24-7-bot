import { pool } from './db.js';

const DEFAULTS = {
  verified_role_id: null
};

export async function getAuthSettings(guildId) {
  const id = String(guildId || '').trim();
  if (!id) {
    throw new Error('guildId is required');
  }

  const result = await pool.query(
    `SELECT
      guild_id,
      verified_role_id,
      updated_at
    FROM guild_auth_settings
    WHERE guild_id = $1`,
    [id]
  );

  const row = result.rows[0] || null;
  if (!row) {
    return { guild_id: id, ...DEFAULTS };
  }

  return {
    guild_id: row.guild_id,
    verified_role_id: row.verified_role_id,
    updated_at: row.updated_at
  };
}

export async function upsertAuthSettings(guildId, partialSettings) {
  const id = String(guildId || '').trim();
  if (!id) {
    throw new Error('guildId is required');
  }

  const current = await getAuthSettings(id);
  const merged = {
    ...current,
    ...partialSettings
  };

  const result = await pool.query(
    `INSERT INTO guild_auth_settings (
      guild_id,
      verified_role_id,
      updated_at
    )
    VALUES ($1, $2, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      verified_role_id = EXCLUDED.verified_role_id,
      updated_at = NOW()
    RETURNING
      guild_id,
      verified_role_id,
      updated_at`,
    [id, merged.verified_role_id ? String(merged.verified_role_id) : null]
  );

  return result.rows[0];
}
