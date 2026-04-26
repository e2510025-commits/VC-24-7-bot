-- リアルタイムスコア投稿用チャンネルIDカラムを追加
ALTER TABLE osu_guild_settings 
ADD COLUMN IF NOT EXISTS realtime_score_channel_id TEXT;

-- コメント追加
COMMENT ON COLUMN osu_guild_settings.realtime_score_channel_id IS 'リアルタイムスコア投稿先のDiscordチャンネルID';
