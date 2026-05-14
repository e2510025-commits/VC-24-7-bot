import { pool } from './db.js';

const DEFAULT_SETTINGS = {
  channel_id: null,
  message_id: null,
  description: null
};

function normalizeId(value) {
  const id = String(value || '').trim();
  return id || null;
}

export async function getRolePanelSettings(guildId) {
  const id = normalizeId(guildId);
  if (!id) {
    throw new Error('guildId is required');
  }

  const result = await pool.query(
    `SELECT
      guild_id,
      channel_id,
      message_id,
      description,
      updated_at
    FROM role_panel_settings
    WHERE guild_id = $1`,
    [id]
  );

  const row = result.rows[0] || null;
  if (!row) {
    return { guild_id: id, ...DEFAULT_SETTINGS };
  }

  return {
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    message_id: row.message_id,
    description: row.description,
    updated_at: row.updated_at
  };
}

export async function upsertRolePanelSettings(guildId, partialSettings) {
  const id = normalizeId(guildId);
  if (!id) {
    throw new Error('guildId is required');
  }

  const current = await getRolePanelSettings(id);
  const merged = {
    ...current,
    ...partialSettings
  };

  const result = await pool.query(
    `INSERT INTO role_panel_settings (
      guild_id,
      channel_id,
      message_id,
      description,
      updated_at
    )
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      message_id = EXCLUDED.message_id,
      description = EXCLUDED.description,
      updated_at = NOW()
    RETURNING
      guild_id,
      channel_id,
      message_id,
      description,
      updated_at`,
    [
      id,
      normalizeId(merged.channel_id),
      normalizeId(merged.message_id),
      merged.description ? String(merged.description) : null
    ]
  );

  return result.rows[0];
}

export async function listRolePanelItems(guildId) {
  const id = normalizeId(guildId);
  if (!id) {
    throw new Error('guildId is required');
  }

  const result = await pool.query(
    `SELECT
      role_id,
      emoji_key,
      emoji_label,
      created_at,
      updated_at
    FROM role_panel_items
    WHERE guild_id = $1
    ORDER BY id ASC`,
    [id]
  );

  return result.rows || [];
}

export async function getRolePanelItemByEmoji(guildId, emojiKey) {
  const id = normalizeId(guildId);
  const key = normalizeId(emojiKey);
  if (!id || !key) {
    throw new Error('guildId and emojiKey are required');
  }

  const result = await pool.query(
    `SELECT
      role_id,
      emoji_key,
      emoji_label,
      created_at,
      updated_at
    FROM role_panel_items
    WHERE guild_id = $1 AND emoji_key = $2`,
    [id, key]
  );

  return result.rows[0] || null;
}

export async function upsertRolePanelItem(guildId, { roleId, emojiKey, emojiLabel }) {
  const id = normalizeId(guildId);
  const role = normalizeId(roleId);
  const key = normalizeId(emojiKey);
  const label = normalizeId(emojiLabel);

  if (!id || !role || !key || !label) {
    throw new Error('guildId, roleId, emojiKey, emojiLabel are required');
  }

  const result = await pool.query(
    `INSERT INTO role_panel_items (
      guild_id,
      role_id,
      emoji_key,
      emoji_label,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (guild_id, role_id)
    DO UPDATE SET
      emoji_key = EXCLUDED.emoji_key,
      emoji_label = EXCLUDED.emoji_label,
      updated_at = NOW()
    RETURNING
      role_id,
      emoji_key,
      emoji_label,
      created_at,
      updated_at`,
    [id, role, key, label]
  );

  return result.rows[0];
}

export async function deleteRolePanelItem(guildId, roleId) {
  const id = normalizeId(guildId);
  const role = normalizeId(roleId);
  if (!id || !role) {
    throw new Error('guildId and roleId are required');
  }

  const result = await pool.query(
    `DELETE FROM role_panel_items
    WHERE guild_id = $1 AND role_id = $2
    RETURNING role_id`,
    [id, role]
  );

  return result.rows[0] || null;
}
