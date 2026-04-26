# osu! リアルタイムスコア投稿機能

登録ユーザーが曲をプレイしたら、自動で指定チャンネルにスコアを投稿する機能です。

## セットアップ手順

### 1. データベースマイグレーション

PostgreSQLデータベースに以下のSQLを実行してください:

```sql
ALTER TABLE osu_guild_settings 
ADD COLUMN IF NOT EXISTS realtime_score_channel_id TEXT;

COMMENT ON COLUMN osu_guild_settings.realtime_score_channel_id IS 'リアルタイムスコア投稿先のDiscordチャンネルID';
```

または、マイグレーションファイルを実行:

```bash
psql $DATABASE_URL -f migrations/add_realtime_score_channel.sql
```

### 2. 環境変数設定

`.env`ファイルに以下を追加:

```env
# osu! リアルタイムスコア監視設定
OSU_REALTIME_INTERVAL_SECONDS=60  # チェック間隔（秒）
OSU_REALTIME_MODES=osu            # 監視モード（カンマ区切り: osu,taiko,fruits,mania）
```

### 3. 投稿先チャンネル設定

Discordサーバーで以下のコマンドを実行:

```
/osu-admin set-channel type:リアルタイムスコア channel:#スコア投稿チャンネル
```

### 4. ユーザー登録

各ユーザーが以下のコマンドでosu!アカウントを連携:

```
/osu-link username:osu_username
```

## 機能詳細

### 監視間隔

- デフォルト: 60秒ごと
- 最小: 30秒
- 環境変数 `OSU_REALTIME_INTERVAL_SECONDS` で変更可能

### 投稿されるスコア

- 登録ユーザーの最新5件のスコアを監視
- 1時間以内のスコアのみ投稿
- 重複投稿を防ぐため、スコアIDをキャッシュ

### 表示情報

- PP
- 精度
- ランク（XH, X, SH, S, A, B, C, D）
- コンボ
- Miss数
- MOD
- 譜面情報（アーティスト、タイトル、難易度）
- 譜面カバー画像

## トラブルシューティング

### スコアが投稿されない

1. `/osu-admin show` で設定を確認
2. リアルタイムスコアチャンネルが設定されているか確認
3. ユーザーが `/osu-link` で連携済みか確認
4. Botがチャンネルへの投稿権限を持っているか確認

### 投稿が遅い

- `OSU_REALTIME_INTERVAL_SECONDS` を小さくする（最小30秒）
- osu! APIのレート制限に注意

### 古いスコアが投稿される

- 初回起動時は最新5件すべてが投稿される可能性があります
- 1時間以上前のスコアは自動的にスキップされます

## 設定例

### 複数モード監視

```env
OSU_REALTIME_MODES=osu,taiko,mania
```

### 高頻度監視（30秒）

```env
OSU_REALTIME_INTERVAL_SECONDS=30
```

## 注意事項

- osu! APIのレート制限: 1分あたり60リクエスト
- 登録ユーザー数が多い場合は監視間隔を長めに設定してください
- 推奨: ユーザー数 × モード数 × 5 < 60 / (60 / 間隔秒)
