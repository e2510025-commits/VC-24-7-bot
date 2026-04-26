import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getSnapshotsSince, saveOsuSnapshot } from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchBestScores,
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
  { name: '1日', value: '1d' },
  { name: '7日', value: '7d' },
  { name: '30日', value: '30d' },
  { name: '90日', value: '90d' },
  { name: '180日', value: '180d' },
  { name: '全期間', value: 'all' }
];

const GRAPH_TYPE_CHOICES = [
  { name: '単一指標ライン', value: 'metric_line' },
  { name: 'PP + Rank 二軸', value: 'pp_rank_dual' },
  { name: 'PP + Rank 予測グラフ', value: 'pp_rank_forecast' },
  { name: 'Best PP 散布図', value: 'best_pp_scatter' }
];

const FORECAST_DAYS_CHOICES = [
  { name: '7日先', value: '7' },
  { name: '30日先', value: '30' },
  { name: '90日先', value: '90' }
];

const DAILY_TABLE_MAX_ROWS = 10;
const BEST_SCATTER_LIMIT = 100;
const MIN_SCATTER_POINTS_FOR_PERIOD = 8;
const SCORE_GRADE_ORDER = ['D', 'C', 'B', 'A', 'S', 'SH', 'X', 'XH'];
const SCORE_GRADE_COLORS = {
  D: '#E74C3C',
  C: '#9B59B6',
  B: '#3F51B5',
  A: '#4CAF50',
  S: '#F1C40F',
  SH: '#B39DDB',
  X: '#D4AF37',
  XH: '#90CAF9'
};

function toDateLabel(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return '??';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}/${day}`;
}

function toDateTimeLabel(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return '??';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}/${day} ${hour}:${minute}`;
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

function formatRank(rank) {
  const numeric = toFiniteNumber(rank);
  if (numeric === null || numeric <= 0) {
    return 'N/A';
  }

  return `#${formatNumber(Math.trunc(numeric))}`;
}

function formatRankChange(delta) {
  const numeric = toFiniteNumber(delta);
  if (numeric === null) {
    return 'N/A';
  }

  const abs = Math.trunc(Math.abs(numeric));
  if (abs === 0) {
    return '±0';
  }

  return numeric > 0 ? `↑${formatNumber(abs)}` : `↓${formatNumber(abs)}`;
}

function formatSignedDecimal(value, digits = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  if (numeric === 0) {
    return `±${numeric.toFixed(digits)}`;
  }

  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${Math.abs(numeric).toFixed(digits)}`;
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

function buildPpRankSummaryTable(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return 'データ不足';
  }

  const startIndex = Math.max(0, series.length - DAILY_TABLE_MAX_ROWS);
  const rows = [];

  for (let index = startIndex; index < series.length; index += 1) {
    const current = series[index];
    const previous = index > 0 ? series[index - 1] : null;

    const ppDelta =
      previous && current.pp !== null && previous.pp !== null
        ? current.pp - previous.pp
        : null;
    const rankDelta =
      previous && current.rank !== null && previous.rank !== null
        ? previous.rank - current.rank
        : null;

    rows.push(
      `${current.label} | ${current.pp === null ? 'N/A' : `${current.pp.toFixed(2)}pp`} | ${formatRank(current.rank)} | ${formatDailyDelta('pp', ppDelta)} | ${formatRankChange(rankDelta)}`
    );
  }

  const header = 'Date | PP | Rank | dPP | dRank';
  const content = ['```', header, ...rows, '```'].join('\n');

  if (content.length <= 1000) {
    return content;
  }

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

function buildPpRankDualChartConfig({ labels, ppValues, rankValues }) {
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'PP',
          data: ppValues,
          borderColor: '#62B6FF',
          backgroundColor: 'rgba(98, 182, 255, 0.16)',
          yAxisID: 'yPp',
          fill: false,
          tension: 0.2,
          spanGaps: true,
          pointRadius: 2
        },
        {
          label: 'Rank',
          data: rankValues,
          borderColor: '#2F2F2F',
          backgroundColor: 'rgba(47, 47, 47, 0.10)',
          yAxisID: 'yRank',
          fill: false,
          tension: 0.2,
          spanGaps: true,
          pointRadius: 2
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'Total PP and Rank'
        },
        legend: {
          position: 'bottom'
        }
      },
      scales: {
        yPp: {
          type: 'linear',
          position: 'left',
          beginAtZero: false,
          title: {
            display: true,
            text: 'PP'
          }
        },
        yRank: {
          type: 'linear',
          position: 'right',
          reverse: true,
          beginAtZero: false,
          grid: {
            drawOnChartArea: false
          },
          title: {
            display: true,
            text: 'Rank'
          }
        }
      }
    }
  };
}

function buildPpRankForecastChartConfig({
  labels,
  actualPpValues,
  actualRankValues,
  forecastPpValues,
  forecastRankValues
}) {
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'PP (Actual)',
          data: actualPpValues,
          borderColor: '#62B6FF',
          backgroundColor: 'rgba(98, 182, 255, 0.15)',
          yAxisID: 'yPp',
          fill: false,
          tension: 0.2,
          spanGaps: true,
          pointRadius: 2
        },
        {
          label: 'PP (Forecast)',
          data: forecastPpValues,
          borderColor: '#62B6FF',
          borderDash: [8, 6],
          yAxisID: 'yPp',
          fill: false,
          tension: 0.15,
          spanGaps: true,
          pointRadius: 0
        },
        {
          label: 'Rank (Actual)',
          data: actualRankValues,
          borderColor: '#2F2F2F',
          backgroundColor: 'rgba(47, 47, 47, 0.10)',
          yAxisID: 'yRank',
          fill: false,
          tension: 0.2,
          spanGaps: true,
          pointRadius: 2
        },
        {
          label: 'Rank (Forecast)',
          data: forecastRankValues,
          borderColor: '#2F2F2F',
          borderDash: [8, 6],
          yAxisID: 'yRank',
          fill: false,
          tension: 0.15,
          spanGaps: true,
          pointRadius: 0
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: 'PP and Rank Forecast'
        },
        legend: {
          position: 'bottom'
        }
      },
      scales: {
        yPp: {
          type: 'linear',
          position: 'left',
          beginAtZero: false,
          title: {
            display: true,
            text: 'PP'
          }
        },
        yRank: {
          type: 'linear',
          position: 'right',
          reverse: true,
          beginAtZero: false,
          grid: {
            drawOnChartArea: false
          },
          title: {
            display: true,
            text: 'Rank'
          }
        }
      }
    }
  };
}

function buildPpRankSeries(dailyPoints) {
  const series = [];

  for (const point of dailyPoints.values()) {
    const pp = getSnapshotValue(point, 'pp');
    const rank = getSnapshotValue(point, 'global_rank');
    if (pp === null && rank === null) {
      continue;
    }

    const timestamp = new Date(point.captured_at).getTime();
    if (!Number.isFinite(timestamp)) {
      continue;
    }

    series.push({
      timestamp,
      label: toDateLabel(point.captured_at),
      pp: pp === null ? null : Number(pp),
      rank: rank === null ? null : Number(rank)
    });
  }

  return series;
}

function calcPerDayTrend(series, key, lookbackDays = 30) {
  const valid = (series || []).filter(point => toFiniteNumber(point[key]) !== null);
  if (valid.length < 2) {
    return null;
  }

  const last = valid[valid.length - 1];
  const cutoff = last.timestamp - lookbackDays * 24 * 60 * 60 * 1000;
  const inWindow = valid.filter(point => point.timestamp >= cutoff);
  const points = inWindow.length >= 2 ? inWindow : valid;

  const first = points[0];
  const spanDays = (last.timestamp - first.timestamp) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(spanDays) || spanDays < 1) {
    return null;
  }

  return (toFiniteNumber(last[key]) - toFiniteNumber(first[key])) / spanDays;
}

function buildForecastSeries(baseSeries, forecastDays) {
  const series = Array.isArray(baseSeries) ? [...baseSeries] : [];
  if (series.length === 0) {
    return [];
  }

  const last = series[series.length - 1];
  const ppSlope = calcPerDayTrend(series, 'pp');
  const rankSlope = calcPerDayTrend(series, 'rank');

  const points = [];
  for (let offset = 1; offset <= forecastDays; offset += 1) {
    const timestamp = last.timestamp + offset * 24 * 60 * 60 * 1000;

    const pp =
      toFiniteNumber(last.pp) === null || ppSlope === null
        ? null
        : Number((last.pp + ppSlope * offset).toFixed(3));
    const rawRank =
      toFiniteNumber(last.rank) === null || rankSlope === null
        ? null
        : last.rank + rankSlope * offset;
    const rank = rawRank === null ? null : Math.max(1, Number(rawRank.toFixed(3)));

    points.push({
      timestamp,
      label: toDateLabel(timestamp),
      pp,
      rank
    });
  }

  return points;
}

function normalizeScoreGrade(rank) {
  const value = String(rank || '').trim().toUpperCase();
  return SCORE_GRADE_ORDER.includes(value) ? value : 'D';
}

function truncateText(text, maxLength = 56) {
  const value = String(text || 'Unknown Title');
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function buildBestScorePoints(scores, mode) {
  const points = [];

  for (const score of scores || []) {
    const pp = toFiniteNumber(score?.pp);
    const timestamp = new Date(score?.ended_at || score?.created_at).getTime();

    if (pp === null || !Number.isFinite(timestamp)) {
      continue;
    }

    const artist = score?.beatmapset?.artist || 'Unknown Artist';
    const title = score?.beatmapset?.title || 'Unknown Title';
    const diff = score?.beatmap?.version || 'Unknown Diff';
    const scoreId = Number(score?.id);

    points.push({
      timestamp,
      label: toDateLabel(timestamp),
      pp,
      grade: normalizeScoreGrade(score?.rank),
      title: `${artist} - ${title} [${diff}]`,
      url: Number.isFinite(scoreId)
        ? `https://osu.ppy.sh/scores/${score?.mode || mode}/${Math.trunc(scoreId)}`
        : null
    });
  }

  return points.sort((a, b) => a.timestamp - b.timestamp);
}

function calcRegression(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { slope: null, values: [] };
  }

  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let index = 0; index < n; index += 1) {
    const x = index + 1;
    const y = points[index].pp;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }

  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  const values = points.map((_, index) => {
    const x = index + 1;
    return Number((slope * x + intercept).toFixed(4));
  });

  return { slope, values };
}

function buildBestPpScatterChartConfig(points) {
  const labels = points.map(point => point.label);
  const datasets = [];

  for (const grade of SCORE_GRADE_ORDER) {
    const data = points.map(point => (point.grade === grade ? Number(point.pp.toFixed(4)) : null));
    if (!data.some(value => value !== null)) {
      continue;
    }

    datasets.push({
      type: 'line',
      label: `${grade} Scores`,
      data,
      showLine: false,
      pointRadius: 4,
      pointHoverRadius: 5,
      backgroundColor: SCORE_GRADE_COLORS[grade],
      borderColor: SCORE_GRADE_COLORS[grade]
    });
  }

  const regression = calcRegression(points);
  if (regression.values.length > 0) {
    datasets.unshift({
      type: 'line',
      label: 'Linear Regression (pp/play)',
      data: regression.values,
      borderColor: '#A88FD8',
      borderDash: [8, 6],
      pointRadius: 0,
      fill: false,
      tension: 0
    });
  }

  return {
    slope: regression.slope,
    config: {
      type: 'line',
      data: {
        labels,
        datasets
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: 'Best Performance Time-pp Scatter'
          },
          legend: {
            position: 'bottom'
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Date'
            },
            ticks: {
              maxTicksLimit: 12
            }
          },
          y: {
            title: {
              display: true,
              text: 'PP'
            },
            beginAtZero: false
          }
        }
      }
    }
  };
}

function buildBestScoreSampleTable(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return 'データ不足';
  }

  const rows = points
    .slice(-4)
    .reverse()
    .map(point => {
      const link = point.url ? `[${truncateText(point.title)}](${point.url})` : truncateText(point.title);
      return `${toDateTimeLabel(point.timestamp)} | ${point.grade} | ${point.pp.toFixed(2)}pp | ${link}`;
    });

  const header = 'Time | Grade | PP | Beatmap';
  const content = ['```', header, ...rows, '```'].join('\n');
  return content.length <= 1000 ? content : 'データ件数が多いため省略しました';
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
      .setName('chart')
      .setDescription('グラフタイプ')
      .addChoices(...GRAPH_TYPE_CHOICES)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('metric')
      .setDescription('グラフにする指標（単一指標ライン時のみ使用）')
      .addChoices(...GRAPH_METRICS)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('span')
      .setDescription('表示期間')
      .addChoices(...SPAN_CHOICES)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('forecast_days')
      .setDescription('予測日数（予測グラフ時のみ使用）')
      .addChoices(...FORECAST_DAYS_CHOICES)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const chartType = interaction.options.getString('chart') || 'metric_line';
    const forecastDays = Number(interaction.options.getString('forecast_days') || '30');
    const metric = interaction.options.getString('metric') || 'pp';
    const span = interaction.options.getString('span') || '30d';
    const period =
      span === 'all'
        ? { label: '全期間', ms: null, isAllTime: true }
        : PERIOD_MAP[span];

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
    const sinceDate = period.isAllTime ? new Date(0) : new Date(now.getTime() - period.ms);

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

    if (chartType === 'best_pp_scatter') {
      const bestScores = await fetchBestScores(user.id, mode, BEST_SCATTER_LIMIT);
      const allPoints = buildBestScorePoints(bestScores, mode);

      if (allPoints.length === 0) {
        return interaction.editReply('❌ 散布図を作成できるBestスコアデータがありませんでした');
      }

      const filteredPoints = allPoints.filter(point => point.timestamp >= sinceDate.getTime());
      const useFallback = !period.isAllTime && filteredPoints.length < MIN_SCATTER_POINTS_FOR_PERIOD;
      const points = period.isAllTime ? allPoints : useFallback ? allPoints : filteredPoints;

      if (points.length === 0) {
        return interaction.editReply('❌ 指定期間に散布図化できるデータがありませんでした');
      }

      const scatter = buildBestPpScatterChartConfig(points);
      const chartUrl = toQuickChartUrl(scatter.config);
      const highestPp = Math.max(...points.map(point => point.pp));
      const regressionText =
        scatter.slope === null
          ? 'N/A'
          : `${scatter.slope >= 0 ? '+' : '-'}${Math.abs(scatter.slope).toFixed(2)} pp/play`;
      const fallbackNote = useFallback
        ? '\n指定期間データが少ないため、Topスコア全体で描画しています'
        : '';

      const embed = new EmbedBuilder()
        .setColor('#7F8CFF')
        .setTitle(`${user.username} のBest PP散布図 [${getModeLabel(mode)}]`)
        .setURL(`https://osu.ppy.sh/users/${user.id}`)
        .setDescription(`${period.label} / Top${BEST_SCATTER_LIMIT}由来の散布図${fallbackNote}`)
        .addFields(
          {
            name: '統計',
            value: [
              `点数: ${formatNumber(points.length)}件`,
              `回帰傾き: ${regressionText}`,
              `最高PP: ${highestPp.toFixed(2)}pp`
            ].join('\n'),
            inline: true
          },
          {
            name: '最近の点',
            value: buildBestScoreSampleTable(points),
            inline: false
          }
        )
        .setImage(chartUrl)
        .setTimestamp(new Date());

      if (user.avatar_url) {
        embed.setThumbnail(user.avatar_url);
      }

      return interaction.editReply({ embeds: [embed] });
    }

    const snapshots = await getSnapshotsSince({
      osuUserId: user.id,
      mode,
      sinceDate,
      untilDate: now
    });

    const rankHistoryPoints =
      chartType === 'pp_rank_dual' || metric === 'global_rank'
        ? buildRankHistoryPoints(user, sinceDate, now)
        : [];

    const merged = [...rankHistoryPoints, ...snapshots, currentPoint].sort(
      (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
    );

    const dailyPoints = new Map();
    for (const point of merged) {
      const key = new Date(point.captured_at).toISOString().slice(0, 10);
      dailyPoints.set(key, point);
    }

    if (chartType === 'pp_rank_dual' || chartType === 'pp_rank_forecast') {
      const series = buildPpRankSeries(dailyPoints);

      if (series.length === 0) {
        return interaction.editReply('❌ PP+Rankグラフ化できる履歴データがありませんでした');
      }

      const labels = series.map(point => point.label);
      const ppValues = series.map(point => point.pp);
      const rankValues = series.map(point => point.rank);
      let chartUrl = null;
      let forecastNote = '';

      if (chartType === 'pp_rank_forecast') {
        const forecast = buildForecastSeries(series, Math.max(1, Math.min(90, forecastDays)));
        if (forecast.length === 0) {
          return interaction.editReply('❌ 予測用の履歴データが不足しています');
        }

        const forecastLabels = forecast.map(point => point.label);
        const mergedLabels = [...labels, ...forecastLabels];
        const actualPpValues = [...ppValues, ...forecast.map(() => null)];
        const actualRankValues = [...rankValues, ...forecast.map(() => null)];
        const forecastPpValues = [
          ...ppValues.map(() => null),
          ...forecast.map(point => point.pp)
        ];
        const forecastRankValues = [
          ...rankValues.map(() => null),
          ...forecast.map(point => point.rank)
        ];

        const config = buildPpRankForecastChartConfig({
          labels: mergedLabels,
          actualPpValues,
          actualRankValues,
          forecastPpValues,
          forecastRankValues
        });
        chartUrl = toQuickChartUrl(config);

        const ppSlope = calcPerDayTrend(series, 'pp');
        const rankSlope = calcPerDayTrend(series, 'rank');
        forecastNote = [
          `予測日数: ${Math.max(1, Math.min(90, forecastDays))}日`,
          `PP傾き: ${formatSignedDecimal(ppSlope)}pp/日`,
          `Rank傾き: ${formatSignedDecimal(rankSlope)}位/日`
        ].join('\n');
      } else {
        const chartConfig = buildPpRankDualChartConfig({ labels, ppValues, rankValues });
        chartUrl = toQuickChartUrl(chartConfig);
      }

      const rankHistoryNote =
        rankHistoryPoints.length > 0
          ? '\nRankは公開履歴で連携前データを補完しています'
          : '';

      const embed = new EmbedBuilder()
        .setColor('#5DADE2')
        .setTitle(
          chartType === 'pp_rank_forecast'
            ? `${user.username} のPP+Rank予測 [${getModeLabel(mode)}]`
            : `${user.username} のPP+Rank推移 [${getModeLabel(mode)}]`
        )
        .setURL(`https://osu.ppy.sh/users/${user.id}`)
        .setDescription(
          chartType === 'pp_rank_forecast'
            ? `${period.label} / 予測グラフ${rankHistoryNote}`
            : `${period.label} / 二軸グラフ${rankHistoryNote}`
        )
        .addFields(
          {
            name: '現在値',
            value: [
              `PP: ${formatMetricValue('pp', stats.pp)}`,
              `Rank: ${formatRank(stats.global_rank)}`
            ].join('\n'),
            inline: true
          },
          ...(chartType === 'pp_rank_forecast'
            ? [{ name: '予測パラメータ', value: forecastNote, inline: true }]
            : []),
          {
            name: `日次サマリー (最新${Math.min(DAILY_TABLE_MAX_ROWS, series.length)}日)`,
            value: buildPpRankSummaryTable(series),
            inline: false
          }
        )
        .setImage(chartUrl)
        .setTimestamp(new Date());

      if (user.avatar_url) {
        embed.setThumbnail(user.avatar_url);
      }

      return interaction.editReply({ embeds: [embed] });
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
