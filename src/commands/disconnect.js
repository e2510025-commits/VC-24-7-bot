import { SlashCommandBuilder } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('disconnect')
  .setDescription('ボイスチャンネルから切断します');

export async function execute(interaction, musicPlayer) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const guild = interaction.guild;
    const me = guild.members.me;
    const queue = musicPlayer.getQueue(interaction.guildId);
    const connection = musicPlayer.connections.get(interaction.guildId);

    // botがVCに接続していない場合
    if (!queue.audioPlayer && !connection && !me?.voice?.channelId) {
      return interaction.editReply(translate(lang, 'music.notConnected'));
    }

    // プレイヤーを破棄 & キューをクリア & Raw接続も切断
    await musicPlayer.disconnect(interaction.guildId);

    log('ボイスチャンネルから切断しました', 'voice');
    await interaction.editReply(translate(lang, 'music.disconnected'));

  } catch (error) {
    log(`切断エラー: ${error.message}`, 'error');
    await interaction.editReply(translate(lang, 'music.disconnectFailed'));
  }
}
