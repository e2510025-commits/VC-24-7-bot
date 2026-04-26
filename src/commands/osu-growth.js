import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import {
  getClosestSnapshotBefore,
  getSnapshotsSince,
  saveOsuSnapshot
} from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchOsuUser,
  formatNumber,
  formatPlayTime,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

const WINDOWS = [
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '1week', label: '1week', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '1month', label: '1month', ms: 30 * 24 * 60 * 60 * 1000 }
];

const BASELINE_CHOICES = [
  { name: '標準(24h/1week/1month)', value: 'multi' },
  { name: '前日比', value: 'prev_day' },
  { name: '前週同曜日比', value: 'prev_week_same_day' },
  { name: '月初比', value: 'month_start' }
];

const DAILY_SUMMARY_DAYS = 10;
const DAILY_SUMMARY_LOOKBACK_DAYS = 14;
const FORECAST_LOOKBACK_DAYS = 30;

export const data = new SlashCommandBuilder()
  .setName('osu-growth')
  .setDescription('osu!の24h/1week/1month成長率を表示します')
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
      .setName('baseline')
      .setDescription('比較基準')
      .addChoices(...BASELINE_CHOICES)
      .setRequired(false)
  )
  .addNumberOption(option =>
    option
      .setName('target_pp')
      .setDescription('目標PP（指定時に到達予測を表示）')
      .setMinValue(1)
      .setRequired(false)
  );

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

function formatSignedInteger(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  const absValue = Math.trunc(Math.abs(numeric));
  if (absValue === 0) {
    return '±0';
  }

  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${formatNumber(absValue)}`;
}

function formatPercentDelta(delta, baseline) {
  const deltaValue = toFiniteNumber(delta);
  const baselineValue = toFiniteNumber(baseline);

  if (deltaValue === null || baselineValue === null || baselineValue === 0) {
    return '前比 N/A';
  }

  const ratio = (deltaValue / baselineValue) * 100;
  const sign = ratio > 0 ? '+' : ratio < 0 ? '-' : '±';
  return `前比 ${sign}${Math.abs(ratio).toFixed(2)}%`;
}

function formatRank(rank) {
  const numeric = toFiniteNumber(rank);
  if (numeric === null || numeric <= 0) {
    return 'N/A';
  }
  return `#${formatNumber(Math.trunc(numeric))}`;
}

function formatRankDelta(previousRank, currentRank) {
  const prev = toFiniteNumber(previousRank);
  const curr = toFiniteNumber(currentRank);

  if (prev === null || curr === null || prev <= 0 || curr <= 0) {
    return `${formatRank(prev)} -> ${formatRank(curr)} (N/A)`;
  }

  const rankChange = Math.trunc(prev - curr);
  const marker = rankChange > 0 ? `↑${formatNumber(rankChange)}` : rankChange < 0 ? `↓${formatNumber(Math.abs(rankChange))}` : '±0';

  return `${formatRank(prev)} -> ${formatRank(curr)} (${marker})`;
}

function formatDurationDelta(seconds) {
  const numeric = toFiniteNumber(seconds);
  if (numeric === null) {
    return 'N/A';
  }

  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '±';
  const totalSeconds = Math.max(0, Math.trunc(Math.abs(numeric)));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  parts.push(`${minutes}分`);

  return `${sign}${parts.join(' ')}`;
}

function buildWindowFieldValue(currentStats, snapshot) {
  if (!snapshot) {
    return 'データ不足（この期間のスナップショットがありません）';
  }

  const currentPp = toFiniteNumber(currentStats.pp);
  const prevPp = toFiniteNumber(snapshot.pp);
  const ppDelta = currentPp !== null && prevPp !== null ? currentPp - prevPp : null;

  const currentPlayTime = toFiniteNumber(currentStats.play_time);
  const prevPlayTime = toFiniteNumber(snapshot.play_time_seconds);
  const playTimeDelta =
    currentPlayTime !== null && prevPlayTime !== null ? currentPlayTime - prevPlayTime : null;

  const currentPlayCount = toFiniteNumber(currentStats.play_count);
  const prevPlayCount = toFiniteNumber(snapshot.play_count);
  const playCountDelta =
    currentPlayCount !== null && prevPlayCount !== null ? currentPlayCount - prevPlayCount : null;

  return [
    `PP: ${formatSignedDecimal(ppDelta)}pp (${formatPercentDelta(ppDelta, prevPp)})`,
    `プレイ時間: ${formatDurationDelta(playTimeDelta)} (${formatPercentDelta(playTimeDelta, prevPlayTime)})`,
    `プレイ回数: ${formatSignedInteger(playCountDelta)} (${formatPercentDelta(playCountDelta, prevPlayCount)})`,
    `順位: ${formatRankDelta(snapshot.global_rank, currentStats.global_rank)}`,
    `比較基準: ${toDiscordTimestamp(snapshot.captured_at)}`
  ].join('\n');
}

function resolveBaseline(baselineKey, now) {
  switch (baselineKey) {
    case 'prev_day':
      return {
        label: '前日比',
        beforeDate: new Date(now - 24 * 60 * 60 * 1000)
      };
    case 'prev_week_same_day':
      return {
        label: '前週同曜日比',
        beforeDate: new Date(now - 7 * 24 * 60 * 60 * 1000)
      };
    case 'month_start': {
      const date = new Date(now);
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
      return {
        label: '月初比',
        beforeDate: monthStart
      };
    }
    default:
      return null;
  }
}

function toDateLabel(dateLike) {
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) {
    return '??';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}/${day}`;
}

function formatRankMovement(previousRank, currentRank) {
  const prev = toFiniteNumber(previousRank);
  const curr = toFiniteNumber(currentRank);

  if (prev === null || curr === null || prev <= 0 || curr <= 0) {
    return 'N/A';
  }

  const delta = Math.trunc(prev - curr);
  if (delta === 0) {
    return '±0';
  }

  if (delta > 0) {
    return `↑${formatNumber(delta)}`;
  }

  return `↓${formatNumber(Math.abs(delta))}`;
}

function buildDailySummaryTable(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return 'データ不足';
  }

  const rows = [];
  const startIndex = Math.max(0, points.length - DAILY_SUMMARY_DAYS);

  for (let index = startIndex; index < points.length; index += 1) {
    const current = points[index];
    const previous = index > 0 ? points[index - 1] : null;

    const ppValue = toFiniteNumber(current.pp);
    const ppDelta =
      previous && ppValue !== null && toFiniteNumber(previous.pp) !== null
        ? ppValue - toFiniteNumber(previous.pp)
        : null;

    rows.push(
      `${toDateLabel(current.captured_at)} | ${ppValue === null ? 'N/A' : `${ppValue.toFixed(2)}pp`} | ${formatSignedDecimal(ppDelta)}pp | ${formatRankMovement(previous?.global_rank, current.global_rank)}`
    );
  }

  const header = 'Date | PP | DeltaPP | Rank';
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

function formatProjectedRankDelta(delta) {
  const numeric = toFiniteNumber(delta);
  if (numeric === null) {
    return 'N/A';
  }

  const abs = Math.round(Math.abs(numeric));
  if (abs === 0) {
    return '±0';
  }

  // 順位は値が小さくなるほど改善なので、減少は↑で表現する。
  if (numeric < 0) {
    return `↑${formatNumber(abs)}`;
  }
  return `↓${formatNumber(abs)}`;
}

function buildForecastFieldValue(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return 'データ不足（予測には2日以上の履歴が必要です）';
  }

  const first = points[0];
  const last = points[points.length - 1];
  const firstTime = new Date(first.captured_at).getTime();
  const lastTime = new Date(last.captured_at).getTime();
  const spanDays = (lastTime - firstTime) / (24 * 60 * 60 * 1000);

  if (!Number.isFinite(spanDays) || spanDays < 1) {
    return 'データ不足（予測には1日以上の履歴が必要です）';
  }

  const firstPp = toFiniteNumber(first.pp);
  const lastPp = toFiniteNumber(last.pp);
  const ppPerDay =
    firstPp !== null && lastPp !== null
      ? (lastPp - firstPp) / spanDays
      : null;

  const firstRank = toFiniteNumber(first.global_rank);
  const lastRank = toFiniteNumber(last.global_rank);
  const rankPerDay =
    firstRank !== null && lastRank !== null && firstRank > 0 && lastRank > 0
      ? (lastRank - firstRank) / spanDays
      : null;

  const windows = [
    { label: '1日', days: 1 },
    { label: '1週', days: 7 },
    { label: '1ヶ月', days: 30 }
  ];

  return windows
    .map(window => {
      const ppDelta = ppPerDay === null ? 'N/A' : `${formatSignedDecimal(ppPerDay * window.days)}pp`;
      const rankDelta = formatProjectedRankDelta(
        rankPerDay === null ? null : rankPerDay * window.days
      );
      return `${window.label}: PP ${ppDelta} / 順位 ${rankDelta}`;
    })
    .join('\n');
}

function formatRankImprovement(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  const abs = Math.trunc(Math.abs(numeric));
  if (abs === 0) {
    return '±0';
  }

  return numeric > 0 ? `↑${formatNumber(abs)}` : `↓${formatNumber(abs)}`;
}

function buildPeriodComparisonLine({ label, currentDelta, previousDelta, formatter }) {
  if (currentDelta === null || previousDelta === null) {
    return `${label}: データ不足`;
  }

  return `${label}: ${formatter(currentDelta)} / 前期間: ${formatter(previousDelta)} / 差分: ${formatter(currentDelta - previousDelta)}`;
}

function calcPpPerDay(points, lookbackDays) {
  const valid = (points || []).filter(point => toFiniteNumber(point.pp) !== null);
  if (valid.length < 2) {
    return null;
  }

  const last = valid[valid.length - 1];
  const lastTs = new Date(last.captured_at).getTime();
  if (!Number.isFinite(lastTs)) {
    return null;
  }

  const cutoff = lastTs - lookbackDays * 24 * 60 * 60 * 1000;
  const inWindow = valid.filter(point => new Date(point.captured_at).getTime() >= cutoff);
  const source = inWindow.length >= 2 ? inWindow : valid;

  const first = source[0];
  const firstTs = new Date(first.captured_at).getTime();
  const spanDays = (lastTs - firstTs) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(spanDays) || spanDays < 1) {
    return null;
  }

  return (toFiniteNumber(last.pp) - toFiniteNumber(first.pp)) / spanDays;
}

function buildTargetPpForecast(points, currentPp, targetPp) {
  const current = toFiniteNumber(currentPp);
  const target = toFiniteNumber(targetPp);

  if (current === null || target === null) {
    return 'データ不足';
  }

  if (target <= current) {
    return `目標 ${target.toFixed(2)}pp は既に達成済みです`; 
  }

  const need = target - current;
  const slopes = [
    { label: '7日傾向', perDay: calcPpPerDay(points, 7) },
    { label: '30日傾向', perDay: calcPpPerDay(points, 30) }
  ];

  return slopes
    .map(({ label, perDay }) => {
      if (perDay === null || perDay <= 0) {
        return `${label}: 予測不可 (成長傾き不足)`;
      }

      const days = Math.ceil(need / perDay);
      return `${label}: 約${formatNumber(days)}日 (傾き ${formatSignedDecimal(perDay)}pp/日)`;
    })
    .join('\n');
}

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const requestedMode = interaction.options.getString('mode') || 'osu';
    const baseline = interaction.options.getString('baseline') || 'multi';
    const targetPp = interaction.options.getNumber('target_pp');
    const mode = normalizeOsuMode(requestedMode);
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);

    if (!targetUsername) {
      return interaction.editReply(
        '❌ ユーザー名を指定するか、先に `/osu-link username:<osu名>` で連携してください'
      );
    }

    const user = await fetchOsuUser(targetUsername, mode);
    const stats = user.statistics || {};

    const userId = toFiniteNumber(user.id);
    if (userId === null) {
      throw new Error('osu!ユーザーIDの取得に失敗しました');
    }

    const now = Date.now();
    let windowSnapshots = [];
    let baselineComparison = null;

    const [weekStartSnapshot, twoWeeksStartSnapshot, monthStartSnapshot, twoMonthsStartSnapshot] =
      await Promise.all([
        getClosestSnapshotBefore({
          osuUserId: userId,
          mode,
          beforeDate: new Date(now - 7 * 24 * 60 * 60 * 1000)
        }),
        getClosestSnapshotBefore({
          osuUserId: userId,
          mode,
          beforeDate: new Date(now - 14 * 24 * 60 * 60 * 1000)
        }),
        getClosestSnapshotBefore({
          osuUserId: userId,
          mode,
          beforeDate: new Date(now - 30 * 24 * 60 * 60 * 1000)
        }),
        getClosestSnapshotBefore({
          osuUserId: userId,
          mode,
          beforeDate: new Date(now - 60 * 24 * 60 * 60 * 1000)
        })
      ]);

    const dailySnapshots = await getSnapshotsSince({
      osuUserId: userId,
      mode,
      sinceDate: new Date(now - FORECAST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
      untilDate: new Date(now)
    });

    if (baseline === 'multi') {
      windowSnapshots = await Promise.all(
        WINDOWS.map(window =>
          getClosestSnapshotBefore({
            osuUserId: userId,
            mode,
            beforeDate: new Date(now - window.ms)
          })
        )
      );
    } else {
      const baselineInfo = resolveBaseline(baseline, now);
      if (!baselineInfo) {
        return interaction.editReply('❌ baseline の指定が不正です');
      }

      const snapshot = await getClosestSnapshotBefore({
        osuUserId: userId,
        mode,
        beforeDate: baselineInfo.beforeDate
      });

      baselineComparison = {
        label: baselineInfo.label,
        value: buildWindowFieldValue(stats, snapshot)
      };
    }

    await saveOsuSnapshot({
      discordId: interaction.user.id,
      osuUserId: userId,
      osuUsername: user.username,
      mode,
      pp: stats.pp,
      globalRank: stats.global_rank,
      countryRank: stats.country_rank,
      playTimeSeconds: stats.play_time,
      playCount: stats.play_count
    });

    const currentPoint = {
      captured_at: new Date(now).toISOString(),
      pp: stats.pp,
      global_rank: stats.global_rank
    };

    const mergedDailyPoints = [...dailySnapshots, currentPoint].sort(
      (a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime()
    );

    const dailyPointMap = new Map();
    for (const point of mergedDailyPoints) {
      const key = new Date(point.captured_at).toISOString().slice(0, 10);
      dailyPointMap.set(key, point);
    }

    const dailySummaryPoints = [...dailyPointMap.values()];
    const dailySummaryStart = Math.max(0, dailySummaryPoints.length - DAILY_SUMMARY_DAYS);
    const recentSummaryPoints = dailySummaryPoints.slice(dailySummaryStart);

    const currentRank = formatRank(stats.global_rank);
    const currentCountryRank = formatRank(stats.country_rank);

    const embed = new EmbedBuilder()
      .setColor('#FF66AA')
      .setTitle(`${user.username} の成長率 [${modeLabel}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription('前比を表示します（実行時に履歴を自動保存）')
      .setFooter({ text: '初回実行直後は履歴不足になる場合があります。時間をおいて再実行してください。' })
      .setTimestamp(new Date());

    const fields = [
      {
        name: '現在値',
        value: [
          `PP: ${formatNumber(stats.pp)}pp`,
          `順位: ${currentRank}`,
          `国別順位 (${user.country_code || 'N/A'}): ${currentCountryRank}`,
          `プレイ時間: ${formatPlayTime(stats.play_time)}`,
          `プレイ回数: ${formatNumber(stats.play_count)}`
        ].join('\n')
      }
    ];

    if (baseline === 'multi') {
      fields.push(
        {
          name: '24h',
          value: buildWindowFieldValue(stats, windowSnapshots[0]),
          inline: false
        },
        {
          name: '1week',
          value: buildWindowFieldValue(stats, windowSnapshots[1]),
          inline: false
        },
        {
          name: '1month',
          value: buildWindowFieldValue(stats, windowSnapshots[2]),
          inline: false
        }
      );
    } else if (baselineComparison) {
      fields.push({
        name: baselineComparison.label,
        value: baselineComparison.value,
        inline: false
      });
    }

    fields.push({
      name: `日次サマリー (最新${Math.min(DAILY_SUMMARY_DAYS, recentSummaryPoints.length)}日)`,
      value: buildDailySummaryTable(recentSummaryPoints),
      inline: false
    });

    const currentWeekPpDelta =
      weekStartSnapshot && toFiniteNumber(stats.pp) !== null && toFiniteNumber(weekStartSnapshot.pp) !== null
        ? toFiniteNumber(stats.pp) - toFiniteNumber(weekStartSnapshot.pp)
        : null;
    const previousWeekPpDelta =
      weekStartSnapshot && twoWeeksStartSnapshot && toFiniteNumber(weekStartSnapshot.pp) !== null && toFiniteNumber(twoWeeksStartSnapshot.pp) !== null
        ? toFiniteNumber(weekStartSnapshot.pp) - toFiniteNumber(twoWeeksStartSnapshot.pp)
        : null;

    const currentMonthPpDelta =
      monthStartSnapshot && toFiniteNumber(stats.pp) !== null && toFiniteNumber(monthStartSnapshot.pp) !== null
        ? toFiniteNumber(stats.pp) - toFiniteNumber(monthStartSnapshot.pp)
        : null;
    const previousMonthPpDelta =
      monthStartSnapshot && twoMonthsStartSnapshot && toFiniteNumber(monthStartSnapshot.pp) !== null && toFiniteNumber(twoMonthsStartSnapshot.pp) !== null
        ? toFiniteNumber(monthStartSnapshot.pp) - toFiniteNumber(twoMonthsStartSnapshot.pp)
        : null;

    const currentWeekRankDelta =
      weekStartSnapshot && toFiniteNumber(weekStartSnapshot.global_rank) !== null && toFiniteNumber(stats.global_rank) !== null
        ? toFiniteNumber(weekStartSnapshot.global_rank) - toFiniteNumber(stats.global_rank)
        : null;
    const previousWeekRankDelta =
      weekStartSnapshot && twoWeeksStartSnapshot && toFiniteNumber(twoWeeksStartSnapshot.global_rank) !== null && toFiniteNumber(weekStartSnapshot.global_rank) !== null
        ? toFiniteNumber(twoWeeksStartSnapshot.global_rank) - toFiniteNumber(weekStartSnapshot.global_rank)
        : null;

    const currentMonthRankDelta =
      monthStartSnapshot && toFiniteNumber(monthStartSnapshot.global_rank) !== null && toFiniteNumber(stats.global_rank) !== null
        ? toFiniteNumber(monthStartSnapshot.global_rank) - toFiniteNumber(stats.global_rank)
        : null;
    const previousMonthRankDelta =
      monthStartSnapshot && twoMonthsStartSnapshot && toFiniteNumber(twoMonthsStartSnapshot.global_rank) !== null && toFiniteNumber(monthStartSnapshot.global_rank) !== null
        ? toFiniteNumber(twoMonthsStartSnapshot.global_rank) - toFiniteNumber(monthStartSnapshot.global_rank)
        : null;

    fields.push({
      name: '期間比較 (今週vs先週 / 今月vs先月)',
      value: [
        buildPeriodComparisonLine({
          label: 'PP 週次',
          currentDelta: currentWeekPpDelta,
          previousDelta: previousWeekPpDelta,
          formatter: value => `${formatSignedDecimal(value)}pp`
        }),
        buildPeriodComparisonLine({
          label: '順位 週次',
          currentDelta: currentWeekRankDelta,
          previousDelta: previousWeekRankDelta,
          formatter: formatRankImprovement
        }),
        buildPeriodComparisonLine({
          label: 'PP 月次',
          currentDelta: currentMonthPpDelta,
          previousDelta: previousMonthPpDelta,
          formatter: value => `${formatSignedDecimal(value)}pp`
        }),
        buildPeriodComparisonLine({
          label: '順位 月次',
          currentDelta: currentMonthRankDelta,
          previousDelta: previousMonthRankDelta,
          formatter: formatRankImprovement
        })
      ].join('\n'),
      inline: false
    });

    fields.push({
      name: '成長予測 (直近30日傾向)',
      value: buildForecastFieldValue(dailySummaryPoints),
      inline: false
    });

    if (targetPp !== null) {
      fields.push({
        name: `目標PPシミュレーター (${targetPp.toFixed(2)}pp)`,
        value: buildTargetPpForecast(dailySummaryPoints, stats.pp, targetPp),
        inline: false
      });
    }

    embed.addFields(...fields);

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-growth エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ 成長率データ取得中にエラーが発生しました');
  }
}
