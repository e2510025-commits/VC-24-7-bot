import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { listLinkedOsuUsers } from '../database/supabase.js';
import {
  fetchOsuUser,
  formatNumber,
  formatPercent,
  formatPlayTime,
  getModeLabel,
  normalizeOsuMode
} from '../utils/osuApi.js';
import { metricLabel } from '../utils/osuGrowthUtils.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const SERVER_RANK_METRICS = [
  { name: 'PP', value: 'pp' },
  { name: 'グローバル順位', value: 'global_rank' },
  { name: '国別順位', value: 'country_rank' },
  { name: '精度', value: 'accuracy' },
  { name: 'レベル', value: 'level' },
  { name: '最大コンボ', value: 'max_combo' },
  { name: 'プレイ時間', value: 'play_time' },
  { name: 'プレイ回数', value: 'play_count' }
];

const ASCENDING_METRICS = new Set(['global_rank', 'country_rank']);

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getMetricValue(stats, metric) {
  if (!stats) return null;

  switch (metric) {
    case 'pp':
      return toFiniteNumber(stats.pp);
    case 'global_rank':
      return toFiniteNumber(stats.global_rank);
    case 'country_rank':
      return toFiniteNumber(stats.country_rank);
    case 'play_time':
      return toFiniteNumber(stats.play_time);
    case 'play_count':
      return toFiniteNumber(stats.play_count);
    case 'accuracy':
      return toFiniteNumber(stats.hit_accuracy);
    case 'level': {
      const level = stats.level || {};
      const current = toFiniteNumber(level.current) ?? 0;
      const progress = toFiniteNumber(level.progress) ?? 0;
      return current + progress / 100;
    }
    case 'max_combo':
      return toFiniteNumber(stats.maximum_combo);
    default:
      return null;
  }
}

function formatMetric(metric, value, lang) {
  if (value === null) {
    return 'N/A';
  }

  switch (metric) {
    case 'pp':
      return `${value.toFixed(2)}pp`;
    case 'global_rank':
    case 'country_rank':
      return `#${formatNumber(Math.trunc(value))}`;
    case 'play_time':
      return formatPlayTime(value, lang);
    case 'play_count':
      return formatNumber(Math.trunc(value));
    case 'accuracy':
      return formatPercent(value);
    case 'level':
      return value.toFixed(2);
    case 'max_combo':
      return `${formatNumber(Math.trunc(value))}x`;
    default:
      return `${value}`;
  }
}

export const data = new SlashCommandBuilder()
  .setName('osu-server-ranking')
  .setDescription('サーバー内のosu!現在ランキングを表示します')
  .addStringOption(option =>
    option
      .setName('metric')
      .setDescription('ランキング指標')
      .addChoices(...SERVER_RANK_METRICS)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('mode')
      .setDescription('対象モード')
      .addChoices(
        { name: 'std', value: 'osu' },
        { name: 'mania', value: 'mania' },
        { name: 'catch', value: 'fruits' },
        { name: 'taiko', value: 'taiko' }
      )
      .setRequired(false)
  )
  .addIntegerOption(option =>
    option
      .setName('top')
      .setDescription('表示人数 (3〜20)')
      .setMinValue(3)
      .setMaxValue(20)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guild) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    const metric = interaction.options.getString('metric') || 'pp';
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const topCount = interaction.options.getInteger('top') || 10;

    const allLinks = await listLinkedOsuUsers();
    if (allLinks.length === 0) {
      return interaction.editReply(translate(lang, 'osu.serverRanking.noLinks'));
    }

    const guildLinks = [];
    for (const link of allLinks) {
      try {
        await interaction.guild.members.fetch({ user: link.discord_id, force: false });
        guildLinks.push(link);
      } catch {
        // サーバー外ユーザーは除外
      }
    }

    if (guildLinks.length === 0) {
      return interaction.editReply(translate(lang, 'osu.serverRanking.noGuildLinks'));
    }

    const rows = [];

    for (const link of guildLinks) {
      const username = String(link.osu_username || '').trim();
      if (!username) {
        continue;
      }

      try {
        const user = await fetchOsuUser(username, mode);
        const stats = user.statistics || {};
        const value = getMetricValue(stats, metric);
        if (value === null) {
          continue;
        }

        rows.push({
          discordId: link.discord_id,
          osuUsername: user.username,
          value
        });
      } catch (error) {
        log(`/osu-server-ranking 解析失敗: ${username} [${mode}] - ${error.message}`, 'error');
      }
    }

    const sorted = rows
      .filter(item => Number.isFinite(item.value))
      .sort((a, b) => {
        if (ASCENDING_METRICS.has(metric)) {
          return a.value - b.value;
        }
        return b.value - a.value;
      })
      .slice(0, topCount);

    if (sorted.length === 0) {
      return interaction.editReply(translate(lang, 'osu.serverRanking.noData'));
    }

    const embed = new EmbedBuilder()
      .setColor('#2D98DA')
      .setTitle(translate(lang, 'osuServerRanking.title', { mode: getModeLabel(mode) }))
      .setDescription(translate(lang, 'osuServerRanking.description', {
        metric: metricLabel(metric, lang)
      }))
      .addFields({
        name: translate(lang, 'osuServerRanking.topTitle', { count: sorted.length }),
        value: sorted
          .map((item, index) => {
            const mention = `<@${item.discordId}>`;
            return translate(lang, 'osuServerRanking.rowFormat', {
              rank: index + 1,
              mention,
              username: item.osuUsername,
              value: formatMetric(metric, item.value, lang)
            });
          })
          .join('\n')
      })
      .setTimestamp(new Date());

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-server-ranking エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');
    return interaction.editReply(translate(lang, 'osu.serverRanking.failed'));
  }
}
