import pg from 'pg';
import { log } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  log(`PostgreSQL接続エラー: ${err.message}`, 'error');
});

export async function testConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    
    // guild_settings テーブルを自動作成
    await client.query(`
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id VARCHAR(255) PRIMARY KEY,
        volume INTEGER DEFAULT 100
      )
    `);

    // osu! 連携情報保存用テーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_links (
        discord_id VARCHAR(255) PRIMARY KEY,
        osu_username VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // osu! 成長率表示用のスナップショットテーブル
    await client.query(`
      CREATE TABLE IF NOT EXISTS osu_user_snapshots (
        id BIGSERIAL PRIMARY KEY,
        discord_id VARCHAR(255),
        osu_user_id BIGINT NOT NULL,
        osu_username VARCHAR(255),
        mode VARCHAR(16) NOT NULL,
        pp DOUBLE PRECISION,
        global_rank INTEGER,
        country_rank INTEGER,
        play_time_seconds INTEGER,
        play_count INTEGER,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 既存テーブル向けの後方互換マイグレーション
    await client.query('ALTER TABLE osu_user_snapshots ADD COLUMN IF NOT EXISTS discord_id VARCHAR(255)');
    await client.query('ALTER TABLE osu_user_snapshots ADD COLUMN IF NOT EXISTS osu_username VARCHAR(255)');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_osu_user_snapshots_lookup
      ON osu_user_snapshots (osu_user_id, mode, captured_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_osu_user_snapshots_discord_lookup
      ON osu_user_snapshots (discord_id, mode, captured_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS osu_goals (
        id BIGSERIAL PRIMARY KEY,
        discord_id VARCHAR(255) NOT NULL,
        osu_user_id BIGINT NOT NULL,
        osu_username VARCHAR(255) NOT NULL,
        mode VARCHAR(16) NOT NULL,
        metric VARCHAR(32) NOT NULL,
        target_value DOUBLE PRECISION NOT NULL,
        baseline_value DOUBLE PRECISION NOT NULL,
        period_days INTEGER NOT NULL,
        start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        end_at TIMESTAMPTZ NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        reminder_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('ALTER TABLE osu_goals ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_osu_goals_discord_active
      ON osu_goals (discord_id, active, mode)
    `);

    // osu! 通知・レポート設定（ギルド単位）
    await client.query(`
      CREATE TABLE IF NOT EXISTS osu_guild_settings (
        guild_id VARCHAR(255) PRIMARY KEY,
        alert_channel_id VARCHAR(255),
        report_channel_id VARCHAR(255),
        alert_pp_threshold DOUBLE PRECISION NOT NULL DEFAULT 10,
        alert_rank_threshold INTEGER NOT NULL DEFAULT 500,
        snapshot_interval_minutes INTEGER NOT NULL DEFAULT 60,
        report_weekday INTEGER NOT NULL DEFAULT 1,
        report_hour_utc INTEGER NOT NULL DEFAULT 12,
        report_period VARCHAR(16) NOT NULL DEFAULT '1week',
        report_metric VARCHAR(32) NOT NULL DEFAULT 'pp',
        report_top INTEGER NOT NULL DEFAULT 10,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // osu! ベストプレイ追跡
    await client.query(`
      CREATE TABLE IF NOT EXISTS osu_best_scores (
        id BIGSERIAL PRIMARY KEY,
        discord_id VARCHAR(255) NOT NULL,
        osu_user_id BIGINT NOT NULL,
        osu_username VARCHAR(255) NOT NULL,
        mode VARCHAR(16) NOT NULL,
        score_id BIGINT,
        pp DOUBLE PRECISION,
        beatmap_id BIGINT,
        beatmap_title VARCHAR(512),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (osu_user_id, mode)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_osu_best_scores_discord_mode
      ON osu_best_scores (discord_id, mode)
    `);
    
    client.release();
    log('PostgreSQL接続成功', 'success');
    return true;
  } catch (error) {
    log(`PostgreSQL接続失敗: ${error.message}`, 'error');
    return false;
  }
}
