# VC 24/7 Bot + Dashboard

Discord.js v14のボットとNext.jsのダッシュボードをまとめた構成です。音楽再生、VC滞在、osu!関連機能、通話ログ表示を扱います。

## 機能

### Discord Bot
- 24時間VC滞在
- Lavalink経由の音楽再生
- `/play`で検索・選曲（Select Menu）
- Embed操作パネル（スキップ、一時停止、リピート）
- 通話ログの保存
- osu!連携と各種コマンド（成長、プロフィール、ランキングなど）
- リアルタイムスコア通知
- 日次プレイ履歴（DM/チャンネル送信）
- 週次レポート、成長アラート

### Webダッシュボード
- 通話ログの一覧表示
- フィルタとページング
- Next.js + Tailwind CSS

## 構成

```
Discord Bot (Koyeb) ←→ PostgreSQL (Supabase/Neonなど) ←→ Dashboard (Vercel)
         ↓
    Lavalink
```

## 必要な環境

### Bot
- Node.js 20以上
- PostgreSQL
- Discord Bot Token
- Lavalinkノード
- osu! APIのClient ID / Client Secret
- Supabaseプロジェクト（osu!連携を使う場合）

### Dashboard
- Node.js 20以上
- PostgreSQL

## セットアップ

### 1. PostgreSQLの準備

Botは起動時に必要なテーブルを自動作成します。Dashboard側の通話ログ用テーブルは手動で作成してください。

```sql
CREATE TABLE IF NOT EXISTS voice_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  username VARCHAR(255) NOT NULL,
  guild_id VARCHAR(255) NOT NULL,
  channel_id VARCHAR(255) NOT NULL,
  channel_name VARCHAR(255) NOT NULL,
  action VARCHAR(16) NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_logs_timestamp
  ON voice_logs (timestamp DESC);
```

### 2. Discord Botの設定

```bash
cd bot
npm install
cp .env.example .env
```

`.env`を編集：

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_bot_client_id
GUILD_ID=your_guild_id
VC_CHANNEL_ID=your_voice_channel_id_for_24_7
DATABASE_URL=postgresql://user:password@host:5432/database

OSU_CLIENT_ID=your_osu_client_id
OSU_CLIENT_SECRET=your_osu_client_secret

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

LAVALINK_HOST=lavalink.example.com
LAVALINK_PORT=443
LAVALINK_PASSWORD=youshallnotpass
LAVALINK_SECURE=true

KOYEB_PUBLIC_DOMAIN=your-app.koyeb.app
PORT=8000
```

### 3. Botの起動（ローカル）

```bash
cd bot
npm start
```

### 4. Dashboardの設定

```bash
cd dashboard
npm install
cp .env.example .env
```

`.env`を編集：

```env
DATABASE_URL=postgresql://user:password@host:5432/database
NEXT_PUBLIC_APP_NAME=VC 24/7 Dashboard
```

### 5. Dashboardの起動（ローカル）

```bash
cd dashboard
npm run dev
```

http://localhost:3000 でアクセスできます。

## デプロイ

### Botのデプロイ（Koyeb）

1. [Koyeb](https://www.koyeb.com/)でアカウント作成
2. GitHubリポジトリを接続
3. 以下の設定でデプロイ
   - Build command: `cd bot && npm install`
   - Run command: `cd bot && npm start`
   - Port: `8000`
4. 環境変数を設定（.envの内容）
   - 特に `KOYEB_PUBLIC_DOMAIN` を設定
5. Health Check設定
   - Path: `/health`
   - Port: `8000`

### Dashboardのデプロイ（Vercel）

1. [Vercel](https://vercel.com/)でアカウント作成
2. GitHubリポジトリを接続
3. 以下の設定でデプロイ
   - Framework Preset: Next.js
   - Root Directory: `dashboard`
4. 環境変数を設定（.envの内容）

## 使い方

1. Discordサーバーでボイスチャンネルに参加
2. `/connect`でボットをVCに参加させる（24時間VC運用時は不要）
3. `/play`で音楽を再生
4. `/osu-link` でosu!アカウントを連携
5. 各種osu!コマンドを実行
2. `/play 曲名` で音楽を検索
3. Select Menuから曲を選択
4. 操作パネルのボタンで再生をコントロール
5. 通話ログは自動的にダッシュボードに保存されます

## トラブルシューティング

### Lavalinkに接続できない

- ノードの稼働状況を確認
- ホスト名、ポート、パスワードを確認

### PostgreSQLに接続できない

- `DATABASE_URL`を確認
- SSL設定が必要な環境では`ssl`が有効か確認



