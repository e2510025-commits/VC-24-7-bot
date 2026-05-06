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
import { resolveUserLanguage, translate } from '../utils/i18n.js';
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

function formatPercentDelta(delta, baseline, lang) {
  const deltaValue = toFiniteNumber(delta);
  const baselineValue = toFiniteNumber(baseline);

  if (deltaValue === null || baselineValue === null || baselineValue === 0) {
    return translate(lang, 'osuGrowth.percentDeltaNa');
  }

  const ratio = (deltaValue / baselineValue) * 100;
  const sign = ratio > 0 ? '+' : ratio < 0 ? '-' : '±';
  return translate(lang, 'osuGrowth.percentDelta', {
    sign,
    value: Math.abs(ratio).toFixed(2)
  });
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

function formatDurationDelta(seconds, lang) {
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
  if (days > 0) parts.push(translate(lang, 'osuGrowth.days', { value: days }));
  if (hours > 0) parts.push(translate(lang, 'osuGrowth.hours', { value: hours }));
  parts.push(translate(lang, 'osuGrowth.minutes', { value: minutes }));

  return `${sign}${parts.join(' ')}`;
}

function buildWindowFieldValue(currentStats, snapshot, lang) {
  if (!snapshot) {
    return translate(lang, 'osuGrowth.windowNoData');
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
    `${translate(lang, 'osuGrowth.pp')}: ${formatSignedDecimal(ppDelta)}pp (${formatPercentDelta(ppDelta, prevPp, lang)})`,
    `${translate(lang, 'osuGrowth.playTime')}: ${formatDurationDelta(playTimeDelta, lang)} (${formatPercentDelta(playTimeDelta, prevPlayTime, lang)})`,
    `${translate(lang, 'osuGrowth.playCount')}: ${formatSignedInteger(playCountDelta)} (${formatPercentDelta(playCountDelta, prevPlayCount, lang)})`,
    `${translate(lang, 'osuGrowth.rank')}: ${formatRankDelta(snapshot.global_rank, currentStats.global_rank)}`,
    `${translate(lang, 'osuGrowth.baseline')}: ${toDiscordTimestamp(snapshot.captured_at)}`
  ].join('\n');
}

function resolveBaseline(baselineKey, now) {
  switch (baselineKey) {
    case 'prev_day':
      return {
        labelKey: 'osuGrowth.baselinePrevDay',
        beforeDate: new Date(now - 24 * 60 * 60 * 1000)
      };
    case 'prev_week_same_day':
      return {
        labelKey: 'osuGrowth.baselinePrevWeek',
        beforeDate: new Date(now - 7 * 24 * 60 * 60 * 1000)
      };
    case 'month_start': {
      const date = new Date(now);
      const monthStart = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
      return {
        labelKey: 'osuGrowth.baselineMonthStart',
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

function buildDailySummaryTable(points, lang) {
  if (!Array.isArray(points) || points.length === 0) {
    return translate(lang, 'osuGrowth.noData');
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

  const header = translate(lang, 'osuGrowth.dailyHeader');
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

function buildForecastFieldValue(points, lang) {
  if (!Array.isArray(points) || points.length < 2) {
    return translate(lang, 'osuGrowth.forecastNeedDays', { days: 2 });
  }

  const first = points[0];
  const last = points[points.length - 1];
  const firstTime = new Date(first.captured_at).getTime();
  const lastTime = new Date(last.captured_at).getTime();
  const spanDays = (lastTime - firstTime) / (24 * 60 * 60 * 1000);

  if (!Number.isFinite(spanDays) || spanDays < 1) {
    return translate(lang, 'osuGrowth.forecastNeedDays', { days: 1 });
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
    { label: translate(lang, 'osuGrowth.window1d'), days: 1 },
    { label: translate(lang, 'osuGrowth.window1w'), days: 7 },
    { label: translate(lang, 'osuGrowth.window1m'), days: 30 }
  ];

  return windows
    .map(window => {
      const ppDelta = ppPerDay === null ? 'N/A' : `${formatSignedDecimal(ppPerDay * window.days)}pp`;
      const rankDelta = formatProjectedRankDelta(
        rankPerDay === null ? null : rankPerDay * window.days
      );
      return `${window.label}: ${translate(lang, 'osuGrowth.pp')} ${ppDelta} / ${translate(lang, 'osuGrowth.rank')} ${rankDelta}`;
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

function buildPeriodComparisonLine({ label, currentDelta, previousDelta, formatter }, lang) {
  if (currentDelta === null || previousDelta === null) {
    return translate(lang, 'osuGrowth.periodNoData', { label });
  }

  return translate(lang, 'osuGrowth.periodLine', {
    label,
    current: formatter(currentDelta),
    previous: formatter(previousDelta),
    diff: formatter(currentDelta - previousDelta)
  });
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

function buildTargetPpForecast(points, currentPp, targetPp, lang) {
  const current = toFiniteNumber(currentPp);
  const target = toFiniteNumber(targetPp);

  if (current === null || target === null) {
    return translate(lang, 'osuGrowth.noData');
  }

  if (target <= current) {
    return translate(lang, 'osuGrowth.targetAlreadyMet', { target: target.toFixed(2) });
  }

  const need = target - current;
  const slopes = [
    { label: translate(lang, 'osuGrowth.trend7d'), perDay: calcPpPerDay(points, 7) },
    { label: translate(lang, 'osuGrowth.trend30d'), perDay: calcPpPerDay(points, 30) }
  ];

  return slopes
    .map(({ label, perDay }) => {
      if (perDay === null || perDay <= 0) {
        return translate(lang, 'osuGrowth.trendUnavailable', { label });
      }

      const days = Math.ceil(need / perDay);
      return translate(lang, 'osuGrowth.trendEstimate', {
        label,
        days: formatNumber(days),
        slope: formatSignedDecimal(perDay)
      });
    })
    .join('\n');
}

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const requestedMode = interaction.options.getString('mode') || 'osu';
    const baseline = interaction.options.getString('baseline') || 'multi';
    const targetPp = interaction.options.getNumber('target_pp');
    const mode = normalizeOsuMode(requestedMode);
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);

    if (!targetUsername) {
      return interaction.editReply(
        translate(lang, 'osu.requireLink')
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
        return interaction.editReply(translate(lang, 'osu.growth.invalidBaseline'));
      }

      const snapshot = await getClosestSnapshotBefore({
        osuUserId: userId,
        mode,
        beforeDate: baselineInfo.beforeDate
      });

      baselineComparison = {
        label: translate(lang, baselineInfo.labelKey),
        value: buildWindowFieldValue(stats, snapshot, lang)
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
      .setTitle(translate(lang, 'osuGrowth.title', { username: user.username, mode: modeLabel }))
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(translate(lang, 'osuGrowth.description'))
      .setFooter({ text: translate(lang, 'osuGrowth.footer') })
      .setTimestamp(new Date());

    const fields = [
      {
        name: translate(lang, 'osuGrowth.currentStats'),
        value: [
          `${translate(lang, 'osuGrowth.pp')}: ${formatNumber(stats.pp)}pp`,
          `${translate(lang, 'osuGrowth.rank')}: ${currentRank}`,
          `${translate(lang, 'osuGrowth.countryRank', { country: user.country_code || 'N/A' })}: ${currentCountryRank}`,
          `${translate(lang, 'osuGrowth.playTime')}: ${formatPlayTime(stats.play_time, lang)}`,
          `${translate(lang, 'osuGrowth.playCount')}: ${formatNumber(stats.play_count)}`
        ].join('\n')
      }
    ];

    if (baseline === 'multi') {
      fields.push(
        {
          name: '24h',
          value: buildWindowFieldValue(stats, windowSnapshots[0], lang),
          inline: false
        },
        {
          name: '1week',
          value: buildWindowFieldValue(stats, windowSnapshots[1], lang),
          inline: false
        },
        {
          name: '1month',
          value: buildWindowFieldValue(stats, windowSnapshots[2], lang),
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
      name: translate(lang, 'osuGrowth.dailySummaryTitle', {
        days: Math.min(DAILY_SUMMARY_DAYS, recentSummaryPoints.length)
      }),
      value: buildDailySummaryTable(recentSummaryPoints, lang),
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
      name: translate(lang, 'osuGrowth.periodCompareTitle'),
      value: [
        buildPeriodComparisonLine({
          label: translate(lang, 'osuGrowth.ppWeekly'),
          currentDelta: currentWeekPpDelta,
          previousDelta: previousWeekPpDelta,
          formatter: value => `${formatSignedDecimal(value)}pp`
        }, lang),
        buildPeriodComparisonLine({
          label: translate(lang, 'osuGrowth.rankWeekly'),
          currentDelta: currentWeekRankDelta,
          previousDelta: previousWeekRankDelta,
          formatter: formatRankImprovement
        }, lang),
        buildPeriodComparisonLine({
          label: translate(lang, 'osuGrowth.ppMonthly'),
          currentDelta: currentMonthPpDelta,
          previousDelta: previousMonthPpDelta,
          formatter: value => `${formatSignedDecimal(value)}pp`
        }, lang),
        buildPeriodComparisonLine({
          label: translate(lang, 'osuGrowth.rankMonthly'),
          currentDelta: currentMonthRankDelta,
          previousDelta: previousMonthRankDelta,
          formatter: formatRankImprovement
        }, lang)
      ].join('\n'),
      inline: false
    });

    fields.push({
      name: translate(lang, 'osuGrowth.forecastTitle'),
      value: buildForecastFieldValue(dailySummaryPoints, lang),
      inline: false
    });

    if (targetPp !== null) {
      fields.push({
        name: translate(lang, 'osuGrowth.targetTitle', { target: targetPp.toFixed(2) }),
        value: buildTargetPpForecast(dailySummaryPoints, stats.pp, targetPp, lang),
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

    return interaction.editReply(translate(lang, 'osu.growth.failed'));
  }
}
