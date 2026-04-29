import { pool } from './db.js';

const DEFAULTS = {
  alert_channel_id: null,
  report_channel_id: null,
  realtime_score_channel_id: null,
  daily_history_channel_id: null,
  important_update_role_id: null,
  alert_pp_threshold: 10,
  alert_rank_threshold: 500,
  snapshot_interval_minutes: 60,
  report_weekday: 1,
  report_hour_utc: 12,
  report_period: '1week',
  report_metric: 'pp',
  report_top: 10
};

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function getGuildOsuSettings(guildId) {
  const id = String(guildId || '').trim();
  if (!id) {
    throw new Error('guildId is required');
  }

  const result = await pool.query(
    `SELECT
      guild_id,
      alert_channel_id,
      report_channel_id,
      realtime_score_channel_id,
      daily_history_channel_id,
      important_update_role_id,
      alert_pp_threshold,
      alert_rank_threshold,
      snapshot_interval_minutes,
      report_weekday,
      report_hour_utc,
      report_period,
      report_metric,
      report_top,
      updated_at
    FROM osu_guild_settings
    WHERE guild_id = $1`,
    [id]
  );

  const row = result.rows[0] || null;
  if (!row) {
    return { guild_id: id, ...DEFAULTS };
  }

  return {
    guild_id: row.guild_id,
    alert_channel_id: row.alert_channel_id,
    report_channel_id: row.report_channel_id,
    realtime_score_channel_id: row.realtime_score_channel_id,
    daily_history_channel_id: row.daily_history_channel_id,
    important_update_role_id: row.important_update_role_id,
    alert_pp_threshold: toNumber(row.alert_pp_threshold, DEFAULTS.alert_pp_threshold),
    alert_rank_threshold: Math.trunc(
      toNumber(row.alert_rank_threshold, DEFAULTS.alert_rank_threshold)
    ),
    snapshot_interval_minutes: Math.trunc(
      toNumber(row.snapshot_interval_minutes, DEFAULTS.snapshot_interval_minutes)
    ),
    report_weekday: Math.trunc(toNumber(row.report_weekday, DEFAULTS.report_weekday)),
    report_hour_utc: Math.trunc(toNumber(row.report_hour_utc, DEFAULTS.report_hour_utc)),
    report_period: String(row.report_period || DEFAULTS.report_period),
    report_metric: String(row.report_metric || DEFAULTS.report_metric),
    report_top: Math.trunc(toNumber(row.report_top, DEFAULTS.report_top)),
    updated_at: row.updated_at
  };
}

export async function upsertGuildOsuSettings(guildId, partialSettings) {
  const id = String(guildId || '').trim();
  if (!id) {
    throw new Error('guildId is required');
  }

  const current = await getGuildOsuSettings(id);
  const merged = {
    ...current,
    ...partialSettings
  };

  const result = await pool.query(
    `INSERT INTO osu_guild_settings (
      guild_id,
      alert_channel_id,
      report_channel_id,
      realtime_score_channel_id,
      daily_history_channel_id,
      important_update_role_id,
      alert_pp_threshold,
      alert_rank_threshold,
      snapshot_interval_minutes,
      report_weekday,
      report_hour_utc,
      report_period,
      report_metric,
      report_top,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (guild_id)
    DO UPDATE SET
      alert_channel_id = EXCLUDED.alert_channel_id,
      report_channel_id = EXCLUDED.report_channel_id,
      realtime_score_channel_id = EXCLUDED.realtime_score_channel_id,
      daily_history_channel_id = EXCLUDED.daily_history_channel_id,
      important_update_role_id = EXCLUDED.important_update_role_id,
      alert_pp_threshold = EXCLUDED.alert_pp_threshold,
      alert_rank_threshold = EXCLUDED.alert_rank_threshold,
      snapshot_interval_minutes = EXCLUDED.snapshot_interval_minutes,
      report_weekday = EXCLUDED.report_weekday,
      report_hour_utc = EXCLUDED.report_hour_utc,
      report_period = EXCLUDED.report_period,
      report_metric = EXCLUDED.report_metric,
      report_top = EXCLUDED.report_top,
      updated_at = NOW()
    RETURNING
      guild_id,
      alert_channel_id,
      report_channel_id,
      realtime_score_channel_id,
      daily_history_channel_id,
      important_update_role_id,
      alert_pp_threshold,
      alert_rank_threshold,
      snapshot_interval_minutes,
      report_weekday,
      report_hour_utc,
      report_period,
      report_metric,
      report_top,
      updated_at`,
    [
      id,
      merged.alert_channel_id ? String(merged.alert_channel_id) : null,
      merged.report_channel_id ? String(merged.report_channel_id) : null,
      merged.realtime_score_channel_id ? String(merged.realtime_score_channel_id) : null,
      merged.daily_history_channel_id ? String(merged.daily_history_channel_id) : null,
      merged.important_update_role_id ? String(merged.important_update_role_id) : null,
      toNumber(merged.alert_pp_threshold, DEFAULTS.alert_pp_threshold),
      Math.trunc(toNumber(merged.alert_rank_threshold, DEFAULTS.alert_rank_threshold)),
      Math.max(10, Math.trunc(toNumber(merged.snapshot_interval_minutes, DEFAULTS.snapshot_interval_minutes))),
      Math.min(6, Math.max(0, Math.trunc(toNumber(merged.report_weekday, DEFAULTS.report_weekday)))),
      Math.min(23, Math.max(0, Math.trunc(toNumber(merged.report_hour_utc, DEFAULTS.report_hour_utc)))),
      String(merged.report_period || DEFAULTS.report_period),
      String(merged.report_metric || DEFAULTS.report_metric),
      Math.min(20, Math.max(3, Math.trunc(toNumber(merged.report_top, DEFAULTS.report_top))))
    ]
  );

  return result.rows[0];
}
