import { pool } from './db.js';

const SUPPORTED_LANGUAGES = new Set(['ja', 'en', 'ko']);

function normalizeLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null;
}

export async function getUserLanguage(discordId) {
  const id = String(discordId || '').trim();
  if (!id) {
    throw new Error('discordId is required');
  }

  const result = await pool.query(
    `SELECT
      language
    FROM user_settings
    WHERE discord_id = $1`,
    [id]
  );

  const row = result.rows[0] || null;
  const language = normalizeLanguage(row?.language);
  return language;
}

export async function setUserLanguage(discordId, language) {
  const id = String(discordId || '').trim();
  if (!id) {
    throw new Error('discordId is required');
  }

  const normalized = normalizeLanguage(language);
  if (!normalized) {
    throw new Error('language must be one of: ja, en, ko');
  }

  const result = await pool.query(
    `INSERT INTO user_settings (
      discord_id,
      language,
      updated_at
    )
    VALUES ($1, $2, NOW())
    ON CONFLICT (discord_id)
    DO UPDATE SET
      language = EXCLUDED.language,
      updated_at = NOW()
    RETURNING
      discord_id,
      language,
      updated_at`,
    [id, normalized]
  );

  return result.rows[0];
}

export function listSupportedLanguages() {
  return ['ja', 'en', 'ko'];
}
