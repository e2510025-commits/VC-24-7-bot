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
        osu_user_id BIGINT NOT NULL,
        mode VARCHAR(16) NOT NULL,
        pp DOUBLE PRECISION,
        global_rank INTEGER,
        country_rank INTEGER,
        play_time_seconds INTEGER,
        play_count INTEGER,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_osu_user_snapshots_lookup
      ON osu_user_snapshots (osu_user_id, mode, captured_at DESC)
    `);
    
    client.release();
    log('PostgreSQL接続成功', 'success');
    return true;
  } catch (error) {
    log(`PostgreSQL接続失敗: ${error.message}`, 'error');
    return false;
  }
}
