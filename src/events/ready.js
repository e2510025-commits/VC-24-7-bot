import { log } from '../utils/logger.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { startOsuSnapshotScheduler } from '../services/osuSnapshotScheduler.js';
import { startOsuRealtimeScoreMonitor } from '../services/osuRealtimeScoreMonitor.js';

export const name = 'ready';
export const once = true;

export async function execute(client) {
  log(`${client.user.tag} としてログインしました`, 'success');

  // スラッシュコマンド登録
  try {
    const commands = Array.from(client.commands.values()).map(cmd => cmd.data.toJSON());
    await client.application.commands.set(commands);
    log(`${commands.length}個のコマンドを登録しました`, 'success');
  } catch (error) {
    log(`コマンド登録エラー: ${error.message}`, 'error');
  }

  // osu! 成長データ収集ジョブ
  startOsuSnapshotScheduler(client);

  // osu! リアルタイムスコア監視
  startOsuRealtimeScoreMonitor(client);

  // 24時間VC接続（@discordjs/voice）
  const vcChannelId = process.env.VC_CHANNEL_ID;
  if (vcChannelId) {
    try {
      const channel = await client.channels.fetch(vcChannelId);
      if (!channel?.isVoiceBased()) {
        log(`VC_CHANNEL_ID ${vcChannelId} はVoiceチャンネルではありません`, 'error');
      } else {
        // Gateway接続が安定するまで待機
        await new Promise(resolve => setTimeout(resolve, 3000));

        const queue = client.musicPlayer.getQueue(channel.guildId);
        queue.voiceChannelId = channel.id;

        client.musicPlayer.joinVC(channel.guildId, channel.id);
        await client.musicPlayer.applySavedVolume(channel.guildId);
        log(`24時間VC接続完了 (@discordjs/voice): ${channel.name}`, 'voice');
      }
    } catch (error) {
      log(`24時間VC接続エラー: ${error.message}`, 'error');
    }

    // 定期的にVCに再接続チェック（30秒ごと）
    setInterval(async () => {
      try {
        const guildId = process.env.GUILD_ID;
        if (!guildId) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const me = guild.members.me;
        const connection = client.musicPlayer.connections.get(guildId);
        const queue = client.musicPlayer.getQueue(guildId);

        // 音楽再生中でなく、VCにいない場合は再接続
        if (!queue.current && (!me?.voice?.channelId || !connection || connection.state.status === VoiceConnectionStatus.Destroyed)) {
          log('ボットがVCにいません。再接続します...', 'voice');
          client.musicPlayer.joinVC(guildId, vcChannelId);
        }
      } catch (error) {
        // silent
      }
    }, 30000);
  }
}
