import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import {
  OsuApiError,
  fetchOsuUser,
  getModeLabel,
  formatNumber,
  formatPercent,
  formatPlayTime
} from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('osu-profile')
  .setDescription('osu!プロフィールを詳細表示します')
  .addStringOption(option =>
    option
      .setName('username')
      .setDescription('表示するosu!ユーザー名（省略時は連携済みユーザー）')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('mode')
      .setDescription('表示するモード')
      .addChoices(
        { name: 'std', value: 'osu' },
        { name: 'mania', value: 'mania' },
        { name: 'catch', value: 'fruits' },
        { name: 'taiko', value: 'taiko' }
      )
      .setRequired(false)
  );

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const mode = interaction.options.getString('mode') || 'osu';
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);
    if (!targetUsername) {
      return interaction.editReply(
        translate(lang, 'osu.requireLink')
      );
    }

    const user = await fetchOsuUser(targetUsername, mode);
    const stats = user.statistics || {};
    const grades = stats.grade_counts || {};
    const level = stats.level || {};

    const globalRank = stats.global_rank ? `#${formatNumber(stats.global_rank)}` : 'N/A';
    const countryRank = stats.country_rank ? `#${formatNumber(stats.country_rank)}` : 'N/A';
    const levelCurrent = Number.isFinite(Number(level.current)) ? Number(level.current) : 0;
    const levelProgress = Number.isFinite(Number(level.progress)) ? Number(level.progress) : 0;

    const embed = new EmbedBuilder()
      .setColor('#1EA7FD')
      .setTitle(translate(lang, 'osuProfile.title', { username: user.username, mode: modeLabel }))
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(translate(lang, 'osuProfile.description', {
        globalRank,
        country: user.country_code || 'N/A',
        countryRank
      }))
      .addFields(
        {
          name: translate(lang, 'osuProfile.pp'),
          value: `${formatNumber(stats.pp)}pp`,
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.accuracy'),
          value: formatPercent(stats.hit_accuracy),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.level'),
          value: `${levelCurrent} (${levelProgress}%)`,
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.playTime'),
          value: formatPlayTime(stats.play_time, lang),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.maxCombo'),
          value: `${formatNumber(stats.maximum_combo)}x`,
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.ssh'),
          value: formatNumber(grades.ssh || 0),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.ss'),
          value: formatNumber(grades.ss || 0),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.sh'),
          value: formatNumber(grades.sh || 0),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.s'),
          value: formatNumber(grades.s || 0),
          inline: true
        },
        {
          name: translate(lang, 'osuProfile.a'),
          value: formatNumber(grades.a || 0),
          inline: true
        }
      );

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    const coverUrl = user.cover_url || user.cover?.custom_url || user.cover?.url;
    if (coverUrl) {
      embed.setImage(coverUrl);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-profile エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.profileFailed'));
  }
}