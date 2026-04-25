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
    
    client.release();
    log('PostgreSQL接続成功', 'success');
    return true;
  } catch (error) {
    log(`PostgreSQL接続失敗: ${error.message}`, 'error');
    return false;
  }
}
