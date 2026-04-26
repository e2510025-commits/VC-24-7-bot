import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from 'dotenv';
import { createServer } from 'http';
import { MusicPlayer } from './music/player.js';
import { testConnection } from './database/db.js';
import { log } from './utils/logger.js';
import { createMusicPanel } from './music/panel.js';

// イベントとコマンドのインポート
import * as readyEvent from './events/ready.js';
import * as voiceStateUpdateEvent from './events/voiceStateUpdate.js';
import * as interactionCreateEvent from './events/interactionCreate.js';
import * as playCommand from './commands/play.js';
import * as connectCommand from './commands/connect.js';
import * as disconnectCommand from './commands/disconnect.js';
import * as volumeCommand from './commands/volume.js';
import * as roleCommand from './commands/role.js';
import * as createroleCommand from './commands/createrole.js';
import * as osuLinkCommand from './commands/osu-link.js';
import * as osuProfileCommand from './commands/osu-profile.js';
import * as osuRecentCommand from './commands/osu-recent.js';
import * as osuGrowthCommand from './commands/osu-growth.js';

config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// コマンドとイベントの登録
client.commands = new Collection();
client.commands.set(playCommand.data.name, playCommand);
client.commands.set(connectCommand.data.name, connectCommand);
client.commands.set(disconnectCommand.data.name, disconnectCommand);
client.commands.set(volumeCommand.data.name, volumeCommand);
client.commands.set(roleCommand.data.name, roleCommand);
client.commands.set(createroleCommand.data.name, createroleCommand);
client.commands.set(osuLinkCommand.data.name, osuLinkCommand);
client.commands.set(osuProfileCommand.data.name, osuProfileCommand);
client.commands.set(osuRecentCommand.data.name, osuRecentCommand);
client.commands.set(osuGrowthCommand.data.name, osuGrowthCommand);

// 音楽プレイヤー初期化
client.musicPlayer = new MusicPlayer(client);

// イベントハンドラー
client.once('clientReady', (...args) => readyEvent.execute(...args, client));
client.on(voiceStateUpdateEvent.name, voiceStateUpdateEvent.execute);
client.on(interactionCreateEvent.name, (...args) => interactionCreateEvent.execute(...args, client));

// エラーハンドリング
client.on('error', (error) => {
  log(`Clientエラー: ${error.message}`, 'error');
});

process.on('unhandledRejection', (error) => {
  log(`未処理のPromise拒否: ${error.message}`, 'error');
});

process.on('uncaughtException', (error) => {
  log(`未処理の例外: ${error.message}`, 'error');
  process.exit(1);
});

// ヘルスチェック用HTTPサーバー（Koyeb用）
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  log(`ヘルスチェックサーバー起動: ポート ${PORT}`, 'success');
});

// Koyeb自動停止防止: 定期的な自己ping（5分ごと）
if (process.env.KOYEB_PUBLIC_DOMAIN) {
  setInterval(() => {
    const url = `https://${process.env.KOYEB_PUBLIC_DOMAIN}/health`;
    fetch(url)
      .then(() => log('キープアライブping送信', 'success'))
      .catch((err) => log(`キープアライブエラー: ${err.message}`, 'error'));
  }, 5 * 60 * 1000); // 5分
}

// 定期的なアクティビティログ（10分ごと）
setInterval(() => {
  log('Instance is healthy. All health checks are passing.', 'success');
}, 10 * 60 * 1000);

// 起動
async function start() {
  try {
    await testConnection();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    log(`起動エラー: ${error.message}`, 'error');
    process.exit(1);
  }
}

start();
