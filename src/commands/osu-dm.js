import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import {
  getTrackedOsuUser,
  setTrackedUserDailyDmHistoryEnabled,
  upsertTrackedOsuUser
} from '../database/osuTrackedUsers.js';
import { OsuApiError, fetchOsuUser } from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('osu-dm')
  .setDescription('osu! 日次プレイ履歴DMの受信設定')
  .addBooleanOption(option =>
    option
      .setName('enable')
      .setDescription('ONにすると毎日24:00にDMで日次履歴を受け取ります（省略時は状態表示）')
      .setRequired(false)
  );

async function ensureTrackedUser(discordId) {
  let tracked = await getTrackedOsuUser(discordId);
  if (tracked) {
    return tracked;
  }

  const linkedUsername = await getLinkedOsuUsername(discordId);
  if (!linkedUsername) {
    return null;
  }

  const user = await fetchOsuUser(linkedUsername, null);
  await upsertTrackedOsuUser({
    discordId,
    osuUserId: user.id,
    osuUsername: user.username
  });

  return getTrackedOsuUser(discordId);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const discordId = interaction.user.id;
    const enable = interaction.options.getBoolean('enable');
    const tracked = await ensureTrackedUser(discordId);

    if (!tracked) {
      return interaction.editReply(translate(lang, 'osu.dmNeedLink'));
    }

    if (enable === null) {
      const isEnabled = Boolean(tracked.daily_dm_history_enabled);
      return interaction.editReply(
        translate(lang, 'osu.dmStatus', {
          status: isEnabled ? 'ON' : 'OFF',
          username: tracked.osu_username
        })
      );
    }

    const updated = await setTrackedUserDailyDmHistoryEnabled(discordId, enable);
    if (!updated) {
      return interaction.editReply(translate(lang, 'osu.dmUpdateFailed'));
    }

    return interaction.editReply(
      translate(lang, 'osu.dmUpdated', {
        status: enable ? 'ON' : 'OFF',
        username: updated.osu_username
      })
    );
  } catch (error) {
    log(`/osu-dm エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.dmUpdateFailed'));
  }
}
