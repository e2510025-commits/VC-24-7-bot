ALTER TABLE osu_guild_settings
ADD COLUMN IF NOT EXISTS recruit_channel_id VARCHAR(255);

CREATE TABLE IF NOT EXISTS role_panel_settings (
  guild_id VARCHAR(255) PRIMARY KEY,
  channel_id VARCHAR(255),
  message_id VARCHAR(255),
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_panel_items (
  id BIGSERIAL PRIMARY KEY,
  guild_id VARCHAR(255) NOT NULL,
  role_id VARCHAR(255) NOT NULL,
  emoji_key VARCHAR(128) NOT NULL,
  emoji_label VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, role_id),
  UNIQUE (guild_id, emoji_key)
);

CREATE INDEX IF NOT EXISTS idx_role_panel_items_guild
ON role_panel_items (guild_id);
