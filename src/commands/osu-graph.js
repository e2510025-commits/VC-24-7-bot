import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getSnapshotsSince, saveOsuSnapshot } from '../database/osuSnapshots.js';
import { OsuApiError, fetchOsuUser, getModeLabel, normalizeOsuMode } from '../utils/osuApi.js';
import {
  GRAPH_METRICS,
  PERIOD_MAP,
  formatMetricValue,
  getSnapshotValue,
  getStatsValue,
  metricLabel,
  toQuickChartUrl
} from '../utils/osuGrowthUtils.js';
import { log } from '../utils/logger.js';

const SPAN_CHOICES = [
  { name: '7日', value: '7d' },
  { name: '30日', value: '30d' }
];

function toDateLabel(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return '??';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}/${day}`;
}

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

function buildChartConfig({ labels, values, metric }) {
  const title = `${metricLabel(metric)} 推移`;
  const rankChart = metric === 'global_rank';

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: title,
          data: values,
          borderColor: '#00A8FF',
          backgroundColor: 'rgba(0, 168, 255, 0.20)',
          pointRadius: 3,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.25
        }
      ]
    },
    options: {
      plugins: {
        legend: {
          display: false
        },
        title: {
          display: true,
          text: title
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          reverse: rankChart
        }
      }
    }
  };
}

export const data = new SlashCommandBuilder()
  .setName('osu-graph')
  .setDescription('osu!成長推移をグラフで表示します')
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
  )
  .addStringOption(option =>
    option
      .setName('metric')
      .setDescription('グラフにする指標')
      .addChoices(...GRAPH_METRICS)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('span')
      .setDescription('表示期間')
      .addChoices(...SPAN_CHOICES)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const metric = interaction.options.getString('metric') || 'pp';
    const span = interaction.options.getString('span') || '30d';
    const period = PERIOD_MAP[span];

    if (!period) {
      return interaction.editReply('❌ span の指定が不正です');
    }

    const targetUsername = await resolveTargetUsername(interaction);
    if (!targetUsername) {
      return interaction.editReply(
        '❌ ユーザー名を指定するか、先に /osu-link username:<osu名> で連携してください'
      );
    }

    const user = await fetchOsuUser(targetUsername, mode);
    const stats = user.statistics || {};
    const sinceDate = new Date(Date.now() - period.ms);

    const snapshots = await getSnapshotsSince({
      osuUserId: user.id,
      mode,
      sinceDate,
      untilDate: new Date()
    });

    await saveOsuSnapshot({
      discordId: interaction.user.id,
      osuUserId: user.id,
      osuUsername: user.username,
      mode,
      pp: stats.pp,
      globalRank: stats.global_rank,
      countryRank: stats.country_rank,
      playTimeSeconds: stats.play_time,
      playCount: stats.play_count
    });

    const currentPoint = {
      captured_at: new Date().toISOString(),
      pp: stats.pp,
      global_rank: stats.global_rank,
      play_time_seconds: stats.play_time,
      play_count: stats.play_count
    };

    const merged = [...snapshots, currentPoint].sort(
      (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
    );

    const dailyPoints = new Map();
    for (const point of merged) {
      const key = new Date(point.captured_at).toISOString().slice(0, 10);
      dailyPoints.set(key, point);
    }

    const labels = [];
    const values = [];

    for (const point of dailyPoints.values()) {
      const value = metric === 'global_rank'
        ? getSnapshotValue(point, 'global_rank')
        : getSnapshotValue(point, metric);

      if (value === null) {
        continue;
      }

      labels.push(toDateLabel(point.captured_at));
      values.push(Number(value));
    }

    if (values.length === 0) {
      return interaction.editReply('❌ グラフ化できる履歴データがありませんでした');
    }

    const chartConfig = buildChartConfig({ labels, values, metric });
    const chartUrl = toQuickChartUrl(chartConfig);

    const currentValue = metric === 'global_rank'
      ? getStatsValue(stats, 'global_rank')
      : getStatsValue(stats, metric);

    const embed = new EmbedBuilder()
      .setColor('#00A8FF')
      .setTitle(`${user.username} の推移グラフ [${getModeLabel(mode)}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(`${period.label} / 指標: ${metricLabel(metric)}`)
      .addFields({
        name: '現在値',
        value:
          currentValue === null
            ? 'N/A'
            : formatMetricValue(metric === 'global_rank' ? 'global_rank' : metric, currentValue),
        inline: true
      })
      .setImage(chartUrl)
      .setTimestamp(new Date());

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-graph エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ グラフ生成中にエラーが発生しました');
  }
}
