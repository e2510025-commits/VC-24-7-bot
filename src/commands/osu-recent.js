import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import {
  OsuApiError,
  fetchBeatmap,
  fetchOsuUser,
  fetchRecentScores,
  getModeLabel,
  formatNumber,
  formatRatioPercent,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

const RANK_COLORS = {
  XH: '#F5F7FA',
  X: '#F0E68C',
  SH: '#BDD7FF',
  S: '#FFD966',
  A: '#8BC34A',
  B: '#4FC3F7',
  C: '#FFB74D',
  D: '#E57373',
  F: '#9E9E9E'
};

const RANK_LABELS = {
  XH: 'SSH',
  X: 'SS',
  SH: 'SH'
};

export const data = new SlashCommandBuilder()
  .setName('osu-recent')
  .setDescription('最新のosu!プレイ結果を表示します（失敗含む）')
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

function toHexColor(rank) {
  const color = RANK_COLORS[rank] || '#1EA7FD';
  return Number.parseInt(color.replace('#', ''), 16);
}

function resolveRank(rank) {
  return RANK_LABELS[rank] || rank || 'N/A';
}

function formatPp(pp) {
  const value = Number(pp);
  if (!Number.isFinite(value)) {
    return 'N/A';
  }
  return `${value.toFixed(2)}pp`;
}

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

async function resolveBeatmapset(score) {
  if (score.beatmapset) {
    return score.beatmapset;
  }

  if (!score.beatmap?.id) {
    return null;
  }

  try {
    const beatmap = await fetchBeatmap(score.beatmap.id);
    return beatmap?.beatmapset || null;
  } catch {
    return null;
  }
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
    const [score] = await fetchRecentScores(user.id, mode, 1);

    if (!score) {
      return interaction.editReply('❌ 最新プレイが見つかりませんでした');
    }

    const beatmap = score.beatmap || {};
    const beatmapset = await resolveBeatmapset(score);
    const artist = beatmapset?.artist || 'Unknown Artist';
    const title = beatmapset?.title || 'Unknown Title';
    const version = beatmap?.version || 'Unknown Difficulty';
    const starRating = Number.isFinite(Number(beatmap?.difficulty_rating))
      ? `${Number(beatmap.difficulty_rating).toFixed(2)}★`
      : 'N/A';

    const statistics = score.statistics || {};
    const count300 = statistics.great ?? statistics.perfect ?? 0;
    const count100 = statistics.ok ?? 0;
    const count50 = statistics.meh ?? 0;
    const countMiss = statistics.miss ?? 0;
    const mods = Array.isArray(score.mods) && score.mods.length > 0 ? score.mods.join(', ') : 'NM';
    const status = score.passed ? '成功' : '失敗';
    const playTime = toDiscordTimestamp(score.ended_at || score.created_at);
    const scoreUrl = score.id
      ? `https://osu.ppy.sh/scores/${score.mode || 'osu'}/${score.id}`
      : `https://osu.ppy.sh/users/${user.id}`;

    const embed = new EmbedBuilder()
      .setColor(toHexColor(score.rank))
      .setTitle(`${user.username} の最新プレイ [${modeLabel}]`)
      .setURL(scoreUrl)
      .setDescription(`**${artist} - ${title} [${version}]**`)
      .addFields(
        {
          name: 'スター',
          value: starRating,
          inline: true
        },
        {
          name: 'ランク',
          value: `${resolveRank(score.rank)} (${status})`,
          inline: true
        },
        {
          name: '獲得PP',
          value: formatPp(score.pp),
          inline: true
        },
        {
          name: '精度',
          value: formatRatioPercent(score.accuracy),
          inline: true
        },
        {
          name: 'コンボ',
          value: `${formatNumber(score.max_combo)}x`,
          inline: true
        },
        {
          name: '判定 (300/100/50/Miss)',
          value: `${formatNumber(count300)}/${formatNumber(count100)}/${formatNumber(count50)}/${formatNumber(countMiss)}`,
          inline: true
        },
        {
          name: 'MOD',
          value: mods,
          inline: true
        },
        {
          name: 'プレイ時間',
          value: playTime,
          inline: true
        }
      );

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    const backgroundUrl =
      beatmapset?.covers?.cover ||
      beatmapset?.covers?.card ||
      beatmapset?.covers?.list ||
      beatmapset?.covers?.slimcover;

    if (backgroundUrl) {
      embed.setImage(backgroundUrl);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-recent エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ 最新プレイ取得中にエラーが発生しました');
  }
}