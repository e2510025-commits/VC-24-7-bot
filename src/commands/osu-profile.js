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

  try {
    const mode = interaction.options.getString('mode') || 'osu';
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);
    if (!targetUsername) {
      return interaction.editReply(
        '❌ ユーザー名を指定するか、先に `/osu-link username:<osu名>` で連携してください'
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
      .setTitle(`${user.username} の osu!プロフィール [${modeLabel}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(`**グローバルランク:** ${globalRank}\n**国別ランク (${user.country_code || 'N/A'}):** ${countryRank}`)
      .addFields(
        {
          name: 'PP',
          value: `${formatNumber(stats.pp)}pp`,
          inline: true
        },
        {
          name: '精度',
          value: formatPercent(stats.hit_accuracy),
          inline: true
        },
        {
          name: 'レベル',
          value: `${levelCurrent} (${levelProgress}%)`,
          inline: true
        },
        {
          name: 'プレイ時間',
          value: formatPlayTime(stats.play_time),
          inline: true
        },
        {
          name: '最大コンボ',
          value: `${formatNumber(stats.maximum_combo)}x`,
          inline: true
        },
        {
          name: 'SSH',
          value: formatNumber(grades.ssh || 0),
          inline: true
        },
        {
          name: 'SS',
          value: formatNumber(grades.ss || 0),
          inline: true
        },
        {
          name: 'SH',
          value: formatNumber(grades.sh || 0),
          inline: true
        },
        {
          name: 'S',
          value: formatNumber(grades.s || 0),
          inline: true
        },
        {
          name: 'A',
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

    return interaction.editReply('❌ プロフィール取得中にエラーが発生しました');
  }
}