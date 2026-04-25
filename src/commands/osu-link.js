import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { upsertUserLink } from '../database/supabase.js';
import { OsuApiError, fetchOsuUser } from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('osu-link')
  .setDescription('Discordアカウントとosu!ユーザー名を連携します')
  .addStringOption(option =>
    option
      .setName('username')
      .setDescription('連携するosu!ユーザー名')
      .setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const username = interaction.options.getString('username', true).trim();
  if (!username) {
    return interaction.editReply('❌ osu!ユーザー名を入力してください');
  }

  try {
    const user = await fetchOsuUser(username, null);
    await upsertUserLink(interaction.user.id, user.username);

    await interaction.editReply(
      `✅ Discordアカウントと osu! ユーザー **${user.username}** を連携しました`
    );
  } catch (error) {
    log(`/osu-link エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    const dbError = error?.message ? `: ${error.message}` : '';
    return interaction.editReply(`❌ 連携情報の保存に失敗しました${dbError}`);
  }
}