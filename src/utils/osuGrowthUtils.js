import { formatNumber, formatPlayTime } from './osuApi.js';

export const PERIOD_MAP = {
  '24h': { label: '24h', ms: 24 * 60 * 60 * 1000 },
  '1d': { label: '1日', ms: 24 * 60 * 60 * 1000 },
  '1week': { label: '1week', ms: 7 * 24 * 60 * 60 * 1000 },
  '1month': { label: '1month', ms: 30 * 24 * 60 * 60 * 1000 },
  '7d': { label: '7日', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: '30日', ms: 30 * 24 * 60 * 60 * 1000 },
  '90d': { label: '90日', ms: 90 * 24 * 60 * 60 * 1000 },
  '180d': { label: '180日', ms: 180 * 24 * 60 * 60 * 1000 }
};

export const GOAL_METRICS = [
  { name: 'PP', value: 'pp' },
  { name: 'プレイ時間', value: 'play_time' },
  { name: 'プレイ回数', value: 'play_count' },
  { name: '順位上昇', value: 'rank_improvement' }
];

export const RANK_METRICS = [
  { name: 'PP', value: 'pp' },
  { name: 'プレイ時間', value: 'play_time' },
  { name: 'プレイ回数', value: 'play_count' },
  { name: '順位上昇', value: 'rank_improvement' }
];

export const GRAPH_METRICS = [
  { name: 'PP', value: 'pp' },
  { name: 'プレイ時間', value: 'play_time' },
  { name: 'プレイ回数', value: 'play_count' },
  { name: 'グローバル順位', value: 'global_rank' }
];

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function getStatsValue(stats, metric) {
  if (!stats) return null;

  switch (metric) {
    case 'pp':
      return toFiniteNumber(stats.pp);
    case 'play_time':
      return toFiniteNumber(stats.play_time);
    case 'play_count':
      return toFiniteNumber(stats.play_count);
    case 'global_rank':
      return toFiniteNumber(stats.global_rank);
    default:
      return null;
  }
}

export function getSnapshotValue(snapshot, metric) {
  if (!snapshot) return null;

  switch (metric) {
    case 'pp':
      return toFiniteNumber(snapshot.pp);
    case 'play_time':
      return toFiniteNumber(snapshot.play_time_seconds);
    case 'play_count':
      return toFiniteNumber(snapshot.play_count);
    case 'global_rank':
      return toFiniteNumber(snapshot.global_rank);
    default:
      return null;
  }
}

export function computeGrowthDelta(metric, previousValue, currentValue) {
  const previous = toFiniteNumber(previousValue);
  const current = toFiniteNumber(currentValue);

  if (previous === null || current === null) {
    return null;
  }

  if (metric === 'rank_improvement') {
    if (previous <= 0 || current <= 0) {
      return null;
    }
    return previous - current;
  }

  return current - previous;
}

export function metricLabel(metric) {
  switch (metric) {
    case 'pp':
      return 'PP';
    case 'play_time':
      return 'プレイ時間';
    case 'play_count':
      return 'プレイ回数';
    case 'rank_improvement':
      return '順位上昇';
    case 'global_rank':
      return 'グローバル順位';
    default:
      return metric;
  }
}

export function formatMetricValue(metric, value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  switch (metric) {
    case 'pp':
      return `${numeric.toFixed(2)}pp`;
    case 'play_time':
      return formatPlayTime(numeric);
    case 'play_count':
      return `${formatNumber(Math.trunc(numeric))}`;
    case 'rank_improvement':
      return `${formatNumber(Math.trunc(numeric))}`;
    case 'global_rank':
      return `#${formatNumber(Math.trunc(numeric))}`;
    default:
      return `${numeric}`;
  }
}

export function formatMetricDelta(metric, value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  if (metric === 'play_time') {
    const abs = Math.max(0, Math.trunc(Math.abs(numeric)));
    const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '±';
    const days = Math.floor(abs / 86_400);
    const hours = Math.floor((abs % 86_400) / 3_600);
    const minutes = Math.floor((abs % 3_600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days}日`);
    if (hours > 0) parts.push(`${hours}時間`);
    parts.push(`${minutes}分`);
    return `${sign}${parts.join(' ')}`;
  }

  if (metric === 'pp') {
    if (numeric === 0) return '±0.00pp';
    const sign = numeric > 0 ? '+' : '-';
    return `${sign}${Math.abs(numeric).toFixed(2)}pp`;
  }

  const absInt = formatNumber(Math.trunc(Math.abs(numeric)));
  if (Math.trunc(Math.abs(numeric)) === 0) {
    return '±0';
  }
  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${absInt}`;
}

export function goalProgress(metric, baselineValue, currentValue, targetValue) {
  const baseline = toFiniteNumber(baselineValue);
  const current = toFiniteNumber(currentValue);
  const target = toFiniteNumber(targetValue);

  if (baseline === null || current === null || target === null || target <= 0) {
    return { achieved: null, ratio: null };
  }

  const achieved = computeGrowthDelta(metric, baseline, current);
  if (achieved === null) {
    return { achieved: null, ratio: null };
  }

  const ratio = (achieved / target) * 100;
  return { achieved, ratio };
}

export function toQuickChartUrl(config) {
  const payload = encodeURIComponent(JSON.stringify(config));
  return `https://quickchart.io/chart?c=${payload}`;
}
