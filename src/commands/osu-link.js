import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { upsertUserLink } from '../database/supabase.js';
import { upsertTrackedOsuUser } from '../database/osuTrackedUsers.js';
import { OsuApiError, fetchOsuUser } from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
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
  const lang = await resolveUserLanguage(interaction.user.id);

  const username = interaction.options.getString('username', true).trim();
  if (!username) {
    return interaction.editReply(translate(lang, 'osuLink.needUsername'));
  }

  try {
    const user = await fetchOsuUser(username, null);
    await upsertUserLink(interaction.user.id, user.username);
    await upsertTrackedOsuUser({
      discordId: interaction.user.id,
      osuUserId: user.id,
      osuUsername: user.username
    });

    await interaction.editReply(
      translate(lang, 'osuLink.success', { username: user.username })
    );
  } catch (error) {
    log(`/osu-link エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    const dbError = error?.message ? `: ${error.message}` : '';
    return interaction.editReply(
      translate(lang, 'osuLink.saveFailed', { error: dbError })
    );
  }
}