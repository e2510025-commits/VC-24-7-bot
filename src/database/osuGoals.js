import { pool } from './db.js';

function normalizeMode(mode = 'osu') {
  return String(mode || 'osu').trim().toLowerCase() || 'osu';
}

function normalizeMetric(metric) {
  return String(metric || '').trim().toLowerCase();
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function upsertActiveGoal({
  discordId,
  osuUserId,
  osuUsername,
  mode,
  metric,
  targetValue,
  baselineValue,
  periodDays
}) {
  const normalizedMode = normalizeMode(mode);
  const normalizedMetric = normalizeMetric(metric);
  const userId = toNumber(osuUserId);
  const target = toNumber(targetValue);
  const baseline = toNumber(baselineValue);
  const days = Math.trunc(toNumber(periodDays, 0));

  if (!discordId) throw new Error('discordId is required');
  if (!Number.isFinite(userId)) throw new Error('osuUserId must be a valid number');
  if (!normalizedMetric) throw new Error('metric is required');
  if (!Number.isFinite(target) || target <= 0) throw new Error('targetValue must be > 0');
  if (!Number.isFinite(baseline)) throw new Error('baselineValue must be a valid number');
  if (!Number.isFinite(days) || days <= 0) throw new Error('periodDays must be > 0');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE osu_goals
       SET active = FALSE, updated_at = NOW()
       WHERE discord_id = $1
         AND mode = $2
         AND metric = $3
         AND active = TRUE`,
      [String(discordId), normalizedMode, normalizedMetric]
    );

    const insertResult = await client.query(
      `INSERT INTO osu_goals (
        discord_id,
        osu_user_id,
        osu_username,
        mode,
        metric,
        target_value,
        baseline_value,
        period_days,
        end_at,
        active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($8 || ' days')::INTERVAL, TRUE)
      RETURNING
        id,
        discord_id,
        osu_user_id,
        osu_username,
        mode,
        metric,
        target_value,
        baseline_value,
        period_days,
        start_at,
        end_at,
        active`,
      [
        String(discordId),
        Math.trunc(userId),
        String(osuUsername || ''),
        normalizedMode,
        normalizedMetric,
        target,
        baseline,
        days
      ]
    );

    await client.query('COMMIT');
    return insertResult.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listActiveGoals(discordId, mode = null) {
  if (!discordId) {
    throw new Error('discordId is required');
  }

  const normalizedMode = mode ? normalizeMode(mode) : null;

  const query = normalizedMode
    ? {
        text: `SELECT
          id,
          discord_id,
          osu_user_id,
          osu_username,
          mode,
          metric,
          target_value,
          baseline_value,
          period_days,
          start_at,
          end_at,
          active
        FROM osu_goals
        WHERE discord_id = $1
          AND active = TRUE
          AND end_at >= NOW()
          AND mode = $2
        ORDER BY end_at ASC`,
        values: [String(discordId), normalizedMode]
      }
    : {
        text: `SELECT
          id,
          discord_id,
          osu_user_id,
          osu_username,
          mode,
          metric,
          target_value,
          baseline_value,
          period_days,
          start_at,
          end_at,
          active
        FROM osu_goals
        WHERE discord_id = $1
          AND active = TRUE
          AND end_at >= NOW()
        ORDER BY end_at ASC`,
        values: [String(discordId)]
      };

  const result = await pool.query(query);
  return result.rows;
}

export async function listGoalsExpiringSoon(hours = 48) {
  const numericHours = Math.max(1, Math.trunc(toNumber(hours, 48)));

  const result = await pool.query(
    `SELECT
      id,
      discord_id,
      osu_user_id,
      osu_username,
      mode,
      metric,
      target_value,
      baseline_value,
      period_days,
      start_at,
      end_at,
      active,
      reminder_sent_at
    FROM osu_goals
    WHERE active = TRUE
      AND end_at >= NOW()
      AND end_at <= NOW() + ($1 || ' hours')::INTERVAL
      AND (reminder_sent_at IS NULL OR reminder_sent_at < NOW() - INTERVAL '24 hours')
    ORDER BY end_at ASC`,
    [numericHours]
  );

  return result.rows;
}

export async function markGoalReminderSent(goalId) {
  const id = Number(goalId);
  if (!Number.isFinite(id)) {
    throw new Error('goalId must be a valid number');
  }

  await pool.query(
    `UPDATE osu_goals
     SET reminder_sent_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [Math.trunc(id)]
  );
}

export async function clearActiveGoals(discordId, mode = null, metric = null) {
  if (!discordId) {
    throw new Error('discordId is required');
  }

  const normalizedMode = mode ? normalizeMode(mode) : null;
  const normalizedMetric = metric ? normalizeMetric(metric) : null;

  const conditions = ['discord_id = $1', 'active = TRUE'];
  const values = [String(discordId)];

  if (normalizedMode) {
    values.push(normalizedMode);
    conditions.push(`mode = $${values.length}`);
  }

  if (normalizedMetric) {
    values.push(normalizedMetric);
    conditions.push(`metric = $${values.length}`);
  }

  const result = await pool.query(
    `UPDATE osu_goals
     SET active = FALSE, updated_at = NOW()
     WHERE ${conditions.join(' AND ')}`,
    values
  );

  return result.rowCount || 0;
}
