import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getSnapshotsSince, saveOsuSnapshot } from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchOsuUser,
  formatNumber,
  getModeLabel,
  normalizeOsuMode
} from '../utils/osuApi.js';
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

const DAILY_TABLE_MAX_ROWS = 10;

function toDateLabel(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return '??';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}/${day}`;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function startOfUtcDay(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(dateLike, days) {
  const base = startOfUtcDay(dateLike);
  if (!base) {
    return null;
  }

  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function toSnapshotPointFromRankHistory({ day, rank }) {
  if (!(day instanceof Date) || !Number.isFinite(day.getTime())) {
    return null;
  }

  const globalRank = toFiniteNumber(rank);
  if (globalRank === null || globalRank <= 0) {
    return null;
  }

  return {
    captured_at: day.toISOString(),
    pp: null,
    global_rank: Math.trunc(globalRank),
    play_time_seconds: null,
    play_count: null,
    __source: 'rank_history'
  };
}

function buildRankHistoryPoints(user, sinceDate, untilDate) {
  const history = user?.rank_history?.data;
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  const from = startOfUtcDay(sinceDate);
  const to = startOfUtcDay(untilDate);
  if (!from || !to) {
    return [];
  }

  const lastDay = to;
  const firstDay = addUtcDays(lastDay, -(history.length - 1));
  if (!firstDay) {
    return [];
  }

  const points = [];
  for (let index = 0; index < history.length; index += 1) {
    const day = addUtcDays(firstDay, index);
    if (!day || day < from || day > to) {
      continue;
    }

    const point = toSnapshotPointFromRankHistory({ day, rank: history[index] });
    if (point) {
      points.push(point);
    }
  }

  return points;
}

function formatDailyDelta(metric, delta) {
  const numeric = toFiniteNumber(delta);
  if (numeric === null) {
    return 'N/A';
  }

  if (metric === 'pp') {
    if (numeric === 0) return '±0.00pp';
    const sign = numeric > 0 ? '+' : '-';
    return `${sign}${Math.abs(numeric).toFixed(2)}pp`;
  }

  if (metric === 'play_count') {
    const abs = Math.trunc(Math.abs(numeric));
    if (abs === 0) return '±0';
    const sign = numeric > 0 ? '+' : '-';
    return `${sign}${formatNumber(abs)}`;
  }

  if (metric === 'play_time') {
    const abs = Math.max(0, Math.trunc(Math.abs(numeric)));
    const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '±';
    const hours = Math.floor(abs / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    return `${sign}${hours}h ${minutes}m`;
  }

  if (metric === 'global_rank') {
    const abs = Math.trunc(Math.abs(numeric));
    if (abs === 0) return '±0';

    if (numeric < 0) {
      return `↑${formatNumber(abs)}`;
    }
    return `↓${formatNumber(abs)}`;
  }

  return `${numeric}`;
}

function buildDailySummaryTable(series, metric) {
  if (!Array.isArray(series) || series.length === 0) {
    return 'データ不足';
  }

  const startIndex = Math.max(0, series.length - DAILY_TABLE_MAX_ROWS);
  const rows = [];

  for (let index = startIndex; index < series.length; index += 1) {
    const current = series[index];
    const previous = index > 0 ? series[index - 1] : null;
    const delta = previous ? current.value - previous.value : null;

    rows.push(
      `${current.label} | ${formatMetricValue(metric, current.value)} | ${formatDailyDelta(metric, delta)}`
    );
  }

  const header = 'Date | Value | Delta';
  const content = ['```', header, ...rows, '```'].join('\n');

  if (content.length <= 1000) {
    return content;
  }

  // Embed field limit(1024)に収めるため、古い行から削る。
  while (rows.length > 1) {
    rows.shift();
    const trimmed = ['```', header, ...rows, '```'].join('\n');
    if (trimmed.length <= 1000) {
      return trimmed;
    }
  }

  return ['```', header, rows[0], '```'].join('\n');
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
    const now = new Date();
    const sinceDate = new Date(now.getTime() - period.ms);

    const snapshots = await getSnapshotsSince({
      osuUserId: user.id,
      mode,
      sinceDate,
      untilDate: now
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
      captured_at: now.toISOString(),
      pp: stats.pp,
      global_rank: stats.global_rank,
      play_time_seconds: stats.play_time,
      play_count: stats.play_count
    };

    const rankHistoryPoints =
      metric === 'global_rank' ? buildRankHistoryPoints(user, sinceDate, now) : [];

    const merged = [...rankHistoryPoints, ...snapshots, currentPoint].sort(
      (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
    );

    const dailyPoints = new Map();
    for (const point of merged) {
      const key = new Date(point.captured_at).toISOString().slice(0, 10);
      dailyPoints.set(key, point);
    }

    const labels = [];
    const values = [];
    const series = [];

    for (const point of dailyPoints.values()) {
      const value = metric === 'global_rank'
        ? getSnapshotValue(point, 'global_rank')
        : getSnapshotValue(point, metric);

      if (value === null) {
        continue;
      }

      labels.push(toDateLabel(point.captured_at));
      values.push(Number(value));
      series.push({
        label: toDateLabel(point.captured_at),
        value: Number(value)
      });
    }

    if (values.length === 0) {
      return interaction.editReply('❌ グラフ化できる履歴データがありませんでした');
    }

    const chartConfig = buildChartConfig({ labels, values, metric });
    const chartUrl = toQuickChartUrl(chartConfig);

    const currentValue = metric === 'global_rank'
      ? getStatsValue(stats, 'global_rank')
      : getStatsValue(stats, metric);

    const dataSourceNote =
      metric === 'global_rank' && rankHistoryPoints.length > 0
        ? '\n順位は osu! 公開履歴で連携前データを補完しています'
        : '';

    const embed = new EmbedBuilder()
      .setColor('#00A8FF')
      .setTitle(`${user.username} の推移グラフ [${getModeLabel(mode)}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(`${period.label} / 指標: ${metricLabel(metric)}${dataSourceNote}`)
      .addFields(
        {
          name: '現在値',
          value:
            currentValue === null
              ? 'N/A'
              : formatMetricValue(metric === 'global_rank' ? 'global_rank' : metric, currentValue),
          inline: true
        },
        {
          name: `日次サマリー (最新${Math.min(DAILY_TABLE_MAX_ROWS, series.length)}日)`,
          value: buildDailySummaryTable(series, metric),
          inline: false
        }
      )
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
