import { EmbedBuilder } from 'discord.js';
import { getBestScoreRecord, upsertBestScoreRecord } from '../database/osuBestScores.js';
import { insertBestScoreEvent } from '../database/osuBestScoreEvents.js';
import { listGoalsExpiringSoon, markGoalReminderSent } from '../database/osuGoals.js';
import { getGuildOsuSettings } from '../database/osuGuildSettings.js';
import { listLinkedOsuUsers } from '../database/supabase.js';
import { listTrackedOsuUsers, upsertTrackedOsuUser } from '../database/osuTrackedUsers.js';
import {
  getClosestSnapshotBefore,
  getLatestSnapshot,
  getLatestSnapshotsByDiscordIds,
  saveOsuSnapshot
} from '../database/osuSnapshots.js';
import {
  fetchBestScores,
  fetchOsuUser,
  fetchRecentScores,
  formatNumber,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import {
  PERIOD_MAP,
  computeGrowthDelta,
  formatMetricDelta,
  metricLabel,
  toQuickChartUrl
} from '../utils/osuGrowthUtils.js';
import { log } from '../utils/logger.js';

let schedulerTimer = null;
let isRunning = false;
let lastCollectionAt = 0;
const weeklyReportSentKeys = new Set();

const PP_MILESTONES = [
  1000, 2000, 3000, 4000, 5000, 7000, 10000, 12000, 15000
];

const RANK_MILESTONES = [
  100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100
];
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_HISTORY_DESCRIPTION_LIMIT = 3600;
const DEFAULT_DAILY_HISTORY_TZ_OFFSET = 9;
const DAILY_HISTORY_DEFAULT_RECENT_LIMIT = 100;
const dailyHistorySentDateKeys = new Set();
let hasRunDailyHistoryBootstrap = false;

function parseModes() {
  const raw = process.env.OSU_SNAPSHOT_MODES || 'osu';
  const modes = raw
    .split(',')
    .map(mode => normalizeOsuMode(mode))
    .filter(Boolean);

  return modes.length > 0 ? [...new Set(modes)] : ['osu'];
}

function parseMinutes() {
  const numeric = Number(process.env.OSU_SNAPSHOT_INTERVAL_MINUTES || 60);
  if (!Number.isFinite(numeric) || numeric < 10) {
    return 60;
  }
  return Math.trunc(numeric);
}

function parseDailyHistoryTimezoneOffsetHours() {
  const numeric = Number(
    process.env.OSU_DAILY_HISTORY_TZ_OFFSET_HOURS || DEFAULT_DAILY_HISTORY_TZ_OFFSET
  );
  if (!Number.isFinite(numeric)) {
    return DEFAULT_DAILY_HISTORY_TZ_OFFSET;
  }

  return Math.max(-12, Math.min(14, Math.trunc(numeric)));
}

function parseDailyHistoryRecentLimit() {
  const numeric = Number(process.env.OSU_DAILY_HISTORY_RECENT_LIMIT || DAILY_HISTORY_DEFAULT_RECENT_LIMIT);
  if (!Number.isFinite(numeric)) {
    return DAILY_HISTORY_DEFAULT_RECENT_LIMIT;
  }

  return Math.max(20, Math.min(100, Math.trunc(numeric)));
}

function formatDateKeyWithOffset(timestampMs, offsetHours) {
  const shifted = new Date(timestampMs + offsetHours * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) {
    return null;
  }

  const year = shifted.getUTCFullYear();
  const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${shifted.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfDayWithOffsetMs(timestampMs, offsetHours) {
  const shifted = new Date(timestampMs + offsetHours * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) {
    return null;
  }

  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );

  return dayStartShifted - offsetHours * 60 * 60 * 1000;
}

function isInDailyMidnightWindow(timestampMs, tickMinutes, offsetHours) {
  const shifted = new Date(timestampMs + offsetHours * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime())) {
    return false;
  }

  const minutesAfterMidnight = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return minutesAfterMidnight >= 0 && minutesAfterMidnight < tickMinutes;
}

function resolveDailyHistoryWindow({ nowMs, tickMinutes, offsetHours, bootstrap }) {
  if (bootstrap) {
    const startMs = startOfDayWithOffsetMs(nowMs, offsetHours);
    if (startMs === null) {
      return null;
    }

    const dateKey = formatDateKeyWithOffset(nowMs, offsetHours);
    if (!dateKey) {
      return null;
    }

    return {
      type: 'bootstrap',
      dateKey,
      startMs,
      endMs: nowMs,
      label: `${dateKey} (途中経過)`
    };
  }

  if (!isInDailyMidnightWindow(nowMs, tickMinutes, offsetHours)) {
    return null;
  }

  const endMs = startOfDayWithOffsetMs(nowMs, offsetHours);
  if (endMs === null) {
    return null;
  }

  const startMs = endMs - DAY_MS;
  const dateKey = formatDateKeyWithOffset(endMs - 1, offsetHours);
  if (!dateKey) {
    return null;
  }

  return {
    type: 'daily',
    dateKey,
    startMs,
    endMs,
    label: dateKey
  };
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function shouldCollectNow(minimumMinutes, nowMs) {
  if (lastCollectionAt === 0) {
    return true;
  }

  return nowMs - lastCollectionAt >= minimumMinutes * 60 * 1000;
}

function getModeForReports(modes) {
  return modes[0] || 'osu';
}

function crossedPpMilestone(previousPp, currentPp) {
  const prev = toFiniteNumber(previousPp);
  const curr = toFiniteNumber(currentPp);
  if (prev === null || curr === null) {
    return null;
  }

  for (const milestone of PP_MILESTONES) {
    if (prev < milestone && curr >= milestone) {
      return milestone;
    }
  }

  return null;
}

function crossedRankMilestone(previousRank, currentRank) {
  const prev = toFiniteNumber(previousRank);
  const curr = toFiniteNumber(currentRank);
  if (prev === null || curr === null || prev <= 0 || curr <= 0) {
    return null;
  }

  for (const milestone of RANK_MILESTONES) {
    if (prev > milestone && curr <= milestone) {
      return milestone;
    }
  }

  return null;
}

function buildGrowthAlertEmbed({ user, mode, previous, currentStats, ppThreshold, rankThreshold }) {
  const previousPp = toFiniteNumber(previous.pp);
  const currentPp = toFiniteNumber(currentStats.pp);
  const ppDelta = previousPp !== null && currentPp !== null ? currentPp - previousPp : null;

  const previousRank = toFiniteNumber(previous.global_rank);
  const currentRank = toFiniteNumber(currentStats.global_rank);
  const rankDelta =
    previousRank !== null && currentRank !== null && previousRank > 0 && currentRank > 0
      ? previousRank - currentRank
      : null;

  const shouldAlert =
    (ppDelta !== null && ppDelta >= ppThreshold) ||
    (rankDelta !== null && rankDelta >= rankThreshold);

  if (!shouldAlert) {
    return null;
  }

  return new EmbedBuilder()
    .setColor('#32CD32')
    .setTitle(`成長アラート: ${user.username} [${getModeLabel(mode)}]`)
    .setURL(`https://osu.ppy.sh/users/${user.id}`)
    .setDescription('直近スナップショット比較で大きな成長を検知しました')
    .addFields(
      {
        name: 'PP変化',
        value: ppDelta === null ? 'N/A' : formatMetricDelta('pp', ppDelta),
        inline: true
      },
      {
        name: '順位上昇',
        value: rankDelta === null ? 'N/A' : formatMetricDelta('rank_improvement', rankDelta),
        inline: true
      },
      {
        name: '閾値',
        value: `PP +${Number(ppThreshold).toFixed(2)} / 順位 +${Math.trunc(rankThreshold)}`,
        inline: false
      }
    )
    .setTimestamp(new Date());
}

function buildMilestoneEmbed({ user, mode, ppMilestone, rankMilestone }) {
  if (!ppMilestone && !rankMilestone) {
    return null;
  }

  const parts = [];
  if (ppMilestone) {
    parts.push(`PP ${formatNumber(ppMilestone)} 到達`);
  }
  if (rankMilestone) {
    parts.push(`グローバル順位 #${formatNumber(rankMilestone)} 突破`);
  }

  return new EmbedBuilder()
    .setColor('#F39C12')
    .setTitle(`マイルストーン達成: ${user.username} [${getModeLabel(mode)}]`)
    .setURL(`https://osu.ppy.sh/users/${user.id}`)
    .setDescription(parts.join('\n'))
    .setTimestamp(new Date());
}

function formatAccuracyPercent(accuracyRatio) {
  const value = toFiniteNumber(accuracyRatio);
  if (value === null) {
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatCombo(comboValue) {
  const value = toFiniteNumber(comboValue);
  if (value === null) {
    return 'N/A';
  }
  return `${formatNumber(Math.trunc(value))}x`;
}

function normalizeDailyPlayTitle(score) {
  const beatmap = score?.beatmap || {};
  const beatmapset = score?.beatmapset || {};
  const artist = String(beatmapset.artist || 'Unknown Artist').trim();
  const title = String(beatmapset.title || 'Unknown Title').trim();
  const diff = String(beatmap.version || 'Unknown Diff').trim();
  return `${artist} - ${title} [${diff}]`;
}

function truncateText(text, maxLength = 72) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function buildDailyPlayLine(entry, index, options = {}) {
  const includeUser = options.includeUser !== false;
  const pp = toFiniteNumber(entry.pp);
  const ppText = pp === null ? 'N/A' : `${pp.toFixed(2)}pp`;
  const title = truncateText(entry.title, 72);
  const userText = entry.osuUsername || `osu#${entry.osuUserId}`;
  const scoreLink = entry.scoreUrl ? `[${title}](${entry.scoreUrl})` : title;

  if (includeUser) {
    return `${index + 1}. ${ppText} | ${userText} | ${scoreLink} | ${toDiscordTimestamp(entry.playedAt)}`;
  }

  return `${index + 1}. ${ppText} | ${scoreLink} | ${toDiscordTimestamp(entry.playedAt)}`;
}

function sortDailyEntriesByPp(entries) {
  return [...entries].sort((a, b) => {
    const aPp = toFiniteNumber(a.pp);
    const bPp = toFiniteNumber(b.pp);
    if (aPp === null && bPp === null) {
      return b.playedMs - a.playedMs;
    }
    if (aPp === null) {
      return 1;
    }
    if (bPp === null) {
      return -1;
    }
    return bPp - aPp;
  });
}

function buildDailySummaryLines(summary) {
  if (!summary) {
    return [
      '今日のプレイ時間: N/A',
      '今日の増加順位: N/A',
      '今日の増加PP: N/A'
    ];
  }

  return [
    `今日のプレイ時間: ${formatMetricDelta('play_time', summary.playTimeDelta)}`,
    `今日の増加順位: ${formatMetricDelta('rank_improvement', summary.rankDelta)}`,
    `今日の増加PP: ${formatMetricDelta('pp', summary.ppDelta)}`
  ];
}

function splitLinesToPages(lines, limit = DAILY_HISTORY_DESCRIPTION_LIMIT) {
  const pages = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const nextLength = currentLength + line.length + 1;
    if (current.length > 0 && nextLength > limit) {
      pages.push(current);
      current = [line];
      currentLength = line.length + 1;
      continue;
    }

    current.push(line);
    currentLength = nextLength;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

function analyzeBestScoreUpdate({ ppDelta, accuracyDelta, missDelta, comboDelta }) {
  const ppUp = ppDelta !== null && ppDelta > 0;
  const highPpJump = ppDelta !== null && ppDelta >= 15;
  const accUp = accuracyDelta !== null && accuracyDelta > 0.002;
  const missDown = missDelta !== null && missDelta < 0;
  const comboUp = comboDelta !== null && comboDelta > 0;

  if (ppUp && accUp && missDown && comboUp) {
    return {
      type: '総合改善型',
      confidence: '高',
      comment: '精度・安定感・PPが同時に改善しています。理想的な更新です。',
      action: '同難度帯を2〜3曲ローテして再現率を固めると伸びます。'
    };
  }

  if (highPpJump && (!accUp || !missDown)) {
    return {
      type: '地力突破型',
      confidence: '中',
      comment: '高PP譜面での上振れ更新です。難度突破の兆しがあります。',
      action: '同系統のやや易しめ譜面で成功率を上げて定着させましょう。'
    };
  }

  if (ppUp && accUp && missDown) {
    return {
      type: '精度主導型',
      confidence: '高',
      comment: '判定精度とMiss管理が更新を牽引しています。',
      action: 'ウォームアップに低難度精度譜面を入れると再現しやすいです。'
    };
  }

  if (ppUp && (missDown || comboUp)) {
    return {
      type: '安定感向上型',
      confidence: '中',
      comment: '終盤の崩れが減り、PPに変換できています。',
      action: 'ロング譜面の終盤集中を意識するとさらに伸ばせます。'
    };
  }

  return {
    type: '更新確認',
    confidence: '低',
    comment: 'ベスト更新を確認しました。要因は複合またはデータ不足です。',
    action: '次回は同傾向譜面で再挑戦し、更新要因の再現を確認しましょう。'
  };
}

function buildBestPlayEmbed({ user, mode, bestScore, previousRecord }) {
  const ppNow = toFiniteNumber(bestScore?.pp);
  const ppBefore = toFiniteNumber(previousRecord?.pp);
  const ppDelta = ppNow !== null && ppBefore !== null ? ppNow - ppBefore : null;

  const accuracyNow = toFiniteNumber(bestScore?.accuracy);
  const accuracyBefore = toFiniteNumber(previousRecord?.accuracy);
  const accuracyDelta =
    accuracyNow !== null && accuracyBefore !== null ? accuracyNow - accuracyBefore : null;

  const missNow = toFiniteNumber(bestScore?.statistics?.miss);
  const missBefore = toFiniteNumber(previousRecord?.miss_count);
  const missDelta = missNow !== null && missBefore !== null ? missNow - missBefore : null;

  const comboNow = toFiniteNumber(bestScore?.max_combo);
  const comboBefore = toFiniteNumber(previousRecord?.max_combo);
  const comboDelta = comboNow !== null && comboBefore !== null ? comboNow - comboBefore : null;

  const scoreId = bestScore?.id;
  const beatmap = bestScore?.beatmap || {};
  const beatmapset = bestScore?.beatmapset || {};
  const mods = Array.isArray(bestScore?.mods) && bestScore.mods.length > 0
    ? bestScore.mods.join(', ')
    : 'NM';
  const title = `${beatmapset.artist || 'Unknown Artist'} - ${beatmapset.title || 'Unknown Title'} [${beatmap.version || 'Unknown Diff'}]`;
  const scoreUrl = scoreId
    ? `https://osu.ppy.sh/scores/${bestScore.mode || mode}/${scoreId}`
    : `https://osu.ppy.sh/users/${user.id}`;
  const analysis = analyzeBestScoreUpdate({ ppDelta, accuracyDelta, missDelta, comboDelta });

  return new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle(`ベスト更新: ${user.username} [${getModeLabel(mode)}]`)
    .setURL(scoreUrl)
    .setDescription(title)
    .addFields(
      {
        name: '新ベストPP',
        value: ppNow === null ? 'N/A' : `${ppNow.toFixed(2)}pp`,
        inline: true
      },
      {
        name: '前ベストとの差',
        value:
          ppNow === null || ppBefore === null
            ? 'N/A'
            : formatMetricDelta('pp', ppDelta),
        inline: true
      },
      {
        name: '精度',
        value: `${formatAccuracyPercent(accuracyNow)} (${formatMetricDelta('pp', accuracyDelta === null ? null : accuracyDelta * 100).replace('pp', '%')})`,
        inline: true
      },
      {
        name: 'Miss',
        value:
          missNow === null
            ? 'N/A'
            : `${formatNumber(Math.trunc(missNow))} (${missDelta === null ? 'N/A' : (missDelta === 0 ? '±0' : missDelta > 0 ? `+${formatNumber(Math.trunc(missDelta))}` : `-${formatNumber(Math.trunc(Math.abs(missDelta)))}`)})`,
        inline: true
      },
      {
        name: '最大コンボ',
        value:
          comboNow === null
            ? 'N/A'
            : `${formatCombo(comboNow)} (${comboDelta === null ? 'N/A' : comboDelta === 0 ? '±0' : comboDelta > 0 ? `+${formatNumber(Math.trunc(comboDelta))}` : `-${formatNumber(Math.trunc(Math.abs(comboDelta)))}`})`,
        inline: true
      },
      {
        name: 'MOD',
        value: mods,
        inline: true
      },
      {
        name: '自動コメント',
        value: analysis.comment,
        inline: false
      },
      {
        name: '更新タイプ',
        value: `${analysis.type} (信頼度: ${analysis.confidence})`,
        inline: true
      },
      {
        name: '次アクション',
        value: analysis.action,
        inline: true
      }
    )
    .setTimestamp(new Date());
}

function buildWeeklyReportChartUrl(rows, metric, periodLabel, mode) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const labels = rows.map((row, index) => {
    const username = String(row.osuUsername || `User${index + 1}`).slice(0, 12);
    return `#${index + 1} ${username}`;
  });

  const values = rows.map(row => {
    const numeric = toFiniteNumber(row.delta);
    return numeric === null ? 0 : Number(numeric.toFixed(2));
  });

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `${periodLabel} ${metricLabel(metric)} 変化`,
          data: values,
          backgroundColor: '#4F46E5'
        }
      ]
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: `週次TOP成長 [${getModeLabel(mode)}]`
        },
        legend: {
          display: false
        }
      },
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  };

  return toQuickChartUrl(config);
}

async function sendToGuildAlertChannels(client, guildSettingsMap, discordId, embed) {
  if (!embed) {
    return 0;
  }

  let sent = 0;

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    if (!settings.alert_channel_id) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }

    let isMember = guild.members.cache.has(discordId);
    if (!isMember) {
      try {
        await guild.members.fetch({ user: discordId, force: false });
        isMember = true;
      } catch {
        isMember = false;
      }
    }

    if (!isMember) {
      continue;
    }

    const channel = await client.channels.fetch(settings.alert_channel_id).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    await channel.send({ embeds: [embed] }).catch(() => null);
    sent += 1;
  }

  return sent;
}

async function sendGrowthAlertsToGuildChannels(client, guildSettingsMap, discordId, payload) {
  let sent = 0;

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    if (!settings.alert_channel_id) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }

    let isMember = guild.members.cache.has(discordId);
    if (!isMember) {
      try {
        await guild.members.fetch({ user: discordId, force: false });
        isMember = true;
      } catch {
        isMember = false;
      }
    }

    if (!isMember) {
      continue;
    }

    const embed = buildGrowthAlertEmbed({
      ...payload,
      ppThreshold: Number(settings.alert_pp_threshold || 10),
      rankThreshold: Number(settings.alert_rank_threshold || 500)
    });

    if (!embed) {
      continue;
    }

    const channel = await client.channels.fetch(settings.alert_channel_id).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    await channel.send({ embeds: [embed] }).catch(() => null);
    sent += 1;
  }

  return sent;
}

function getIsoWeekKey(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function sendWeeklyReports(client, guildSettingsMap, links, mode) {
  const now = new Date();
  const nowMs = now.getTime();

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    if (!settings.report_channel_id) {
      continue;
    }

    const targetWeekday = Number(settings.report_weekday);
    const targetHour = Number(settings.report_hour_utc);

    if (now.getUTCDay() !== targetWeekday || now.getUTCHours() !== targetHour) {
      continue;
    }

    const weekKey = `${guildId}:${getIsoWeekKey(now)}`;
    if (weeklyReportSentKeys.has(weekKey)) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }

    const period = PERIOD_MAP[settings.report_period] || PERIOD_MAP['1week'];
    const metric = String(settings.report_metric || 'pp');
    const topCount = Math.min(20, Math.max(3, Number(settings.report_top || 10)));

    const guildDiscordIds = [];
    for (const link of links) {
      const discordId = String(link.discord_id || '');
      if (!discordId) {
        continue;
      }

      let isMember = guild.members.cache.has(discordId);
      if (!isMember) {
        try {
          await guild.members.fetch({ user: discordId, force: false });
          isMember = true;
        } catch {
          isMember = false;
        }
      }

      if (isMember) {
        guildDiscordIds.push(discordId);
      }
    }

    if (guildDiscordIds.length === 0) {
      weeklyReportSentKeys.add(weekKey);
      continue;
    }

    const latestSnapshots = await getLatestSnapshotsByDiscordIds({
      discordIds: guildDiscordIds,
      mode
    });

    const rows = [];
    for (const latest of latestSnapshots) {
      const previous = await getClosestSnapshotBefore({
        osuUserId: latest.osu_user_id,
        mode,
        beforeDate: new Date(nowMs - period.ms)
      });

      if (!previous) {
        continue;
      }

      const previousValue = metric === 'rank_improvement' ? previous.global_rank : previous[metric === 'play_time' ? 'play_time_seconds' : metric === 'play_count' ? 'play_count' : metric === 'pp' ? 'pp' : 'pp'];
      const currentValue = metric === 'rank_improvement' ? latest.global_rank : latest[metric === 'play_time' ? 'play_time_seconds' : metric === 'play_count' ? 'play_count' : metric === 'pp' ? 'pp' : 'pp'];

      const delta = computeGrowthDelta(metric, previousValue, currentValue);
      if (delta === null) {
        continue;
      }

      rows.push({
        discordId: latest.discord_id,
        osuUsername: latest.osu_username || `osu#${latest.osu_user_id}`,
        delta,
        currentValue
      });
    }

    const sorted = rows
      .filter(row => Number.isFinite(row.delta))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, topCount);

    const channel = await client.channels.fetch(settings.report_channel_id).catch(() => null);
    if (channel?.isTextBased() && sorted.length > 0) {
      const chartUrl = buildWeeklyReportChartUrl(sorted, metric, period.label, mode);
      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(`週次レポート [${getModeLabel(mode)}]`)
        .setDescription(`${period.label} / 指標: ${metricLabel(metric)}`)
        .addFields({
          name: `TOP ${sorted.length}`,
          value: sorted
            .map((row, index) =>
              `${index + 1}. <@${row.discordId}> (${row.osuUsername})\n  変化: ${formatMetricDelta(metric, row.delta)}`
            )
            .join('\n')
        })
        .setTimestamp(new Date());

      if (chartUrl) {
        embed.setImage(chartUrl);
      }

      await channel.send({ embeds: [embed] }).catch(() => null);
    }

    weeklyReportSentKeys.add(weekKey);
  }
}

async function sendGoalReminders(client) {
  const goals = await listGoalsExpiringSoon(72);
  if (goals.length === 0) {
    return 0;
  }

  let sentCount = 0;

  for (const goal of goals) {
    try {
      const user = await client.users.fetch(goal.discord_id);
      const embed = new EmbedBuilder()
        .setColor('#E67E22')
        .setTitle('osu! 目標期限リマインド')
        .setDescription(`${goal.osu_username} [${getModeLabel(goal.mode)}] ${metricLabel(goal.metric)}`)
        .addFields(
          {
            name: '目標値',
            value: formatMetricDelta(goal.metric, goal.target_value),
            inline: true
          },
          {
            name: '期限',
            value: toDiscordTimestamp(goal.end_at),
            inline: true
          }
        )
        .setTimestamp(new Date());

      await user.send({ embeds: [embed] }).catch(() => null);
      await markGoalReminderSent(goal.id);
      sentCount += 1;
    } catch {
      // silent
    }
  }

  return sentCount;
}

async function collectDailyPlayHistoryEntries({ trackedUsers, modes, startMs, endMs, recentLimit }) {
  const entriesByMode = new Map(modes.map(mode => [mode, []]));

  for (const trackedUser of trackedUsers) {
    const discordId = String(trackedUser.discord_id || '').trim();
    const username = String(trackedUser.osu_username || '').trim();
    const trackedOsuUserId = toFiniteNumber(trackedUser.osu_user_id);

    if (!discordId || (!username && trackedOsuUserId === null)) {
      continue;
    }

    const lookupTarget = trackedOsuUserId !== null ? trackedOsuUserId : username;

    for (const mode of modes) {
      try {
        const scores = await fetchRecentScores(lookupTarget, mode, recentLimit);
        for (const score of scores || []) {
          const playedAt = score?.ended_at || score?.created_at;
          const playedMs = new Date(playedAt).getTime();
          if (!Number.isFinite(playedMs)) {
            continue;
          }

          if (playedMs < startMs || playedMs >= endMs) {
            continue;
          }

          const scoreId = toFiniteNumber(score?.id);
          const scoreMode = normalizeOsuMode(score?.mode || mode);
          const scoreUrl =
            scoreId === null
              ? null
              : `https://osu.ppy.sh/scores/${scoreMode}/${Math.trunc(scoreId)}`;

          entriesByMode.get(mode).push({
            discordId,
            osuUserId: trackedOsuUserId,
            osuUsername: String(score?.user?.username || username || '').trim(),
            mode,
            pp: score?.pp,
            playedAt,
            playedMs,
            title: normalizeDailyPlayTitle(score),
            scoreUrl
          });
        }
      } catch (error) {
        log(`日次プレイ履歴取得失敗: ${username || trackedOsuUserId} [${mode}] - ${error.message}`, 'error');
      }
    }
  }

  return entriesByMode;
}

async function isGuildMember(guild, discordId, cache) {
  const key = `${guild.id}:${discordId}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  let isMember = guild.members.cache.has(discordId);
  if (!isMember) {
    try {
      await guild.members.fetch({ user: discordId, force: false });
      isMember = true;
    } catch {
      isMember = false;
    }
  }

  cache.set(key, isMember);
  return isMember;
}

function resolveDailyHistoryChannelId(settings) {
  return (
    settings.daily_history_channel_id ||
    settings.report_channel_id ||
    settings.realtime_score_channel_id ||
    settings.alert_channel_id ||
    null
  );
}

async function buildDailyUserModeSummary({ osuUserId, mode, startMs, endMs }) {
  const userId = toFiniteNumber(osuUserId);
  if (userId === null) {
    return null;
  }

  const baseline = await getClosestSnapshotBefore({
    osuUserId: userId,
    mode,
    beforeDate: new Date(startMs)
  });
  const latest = await getClosestSnapshotBefore({
    osuUserId: userId,
    mode,
    beforeDate: new Date(endMs)
  });

  if (!latest) {
    return null;
  }

  return {
    playTimeDelta: computeGrowthDelta('play_time', baseline?.play_time_seconds, latest.play_time_seconds),
    rankDelta: computeGrowthDelta('rank_improvement', baseline?.global_rank, latest.global_rank),
    ppDelta: computeGrowthDelta('pp', baseline?.pp, latest.pp)
  };
}

async function sendDailyPlayHistoryDmReports({
  client,
  trackedUsers,
  entriesByMode,
  modes,
  label,
  reportType,
  startMs,
  endMs
}) {
  const dmTargets = trackedUsers.filter(user => Boolean(user.daily_dm_history_enabled));
  if (dmTargets.length === 0) {
    return 0;
  }

  let sentCount = 0;

  for (const target of dmTargets) {
    const discordId = String(target.discord_id || '').trim();
    if (!discordId) {
      continue;
    }

    const dmUser = await client.users.fetch(discordId).catch(() => null);
    if (!dmUser) {
      continue;
    }

    for (const mode of modes) {
      const ownEntries = (entriesByMode.get(mode) || []).filter(entry => entry.discordId === discordId);
      const sortedEntries = sortDailyEntriesByPp(ownEntries);
      const summary = await buildDailyUserModeSummary({
        osuUserId: target.osu_user_id,
        mode,
        startMs,
        endMs
      });

      const summaryLines = buildDailySummaryLines(summary);

      if (sortedEntries.length === 0) {
        const noDataEmbed = new EmbedBuilder()
          .setColor('#95A5A6')
          .setTitle(`あなたの日次プレイ履歴 [${getModeLabel(mode)}]`)
          .setDescription(
            [
              reportType === 'bootstrap'
                ? `${label} のプレイ履歴（途中集計）`
                : `${label} のプレイ履歴`,
              ...summaryLines,
              '',
              '対象プレイはありませんでした。'
            ].join('\n')
          )
          .setTimestamp(new Date());

        await dmUser.send({ embeds: [noDataEmbed] }).catch(() => null);
        sentCount += 1;
        continue;
      }

      const lines = sortedEntries.map((entry, index) =>
        buildDailyPlayLine(entry, index, { includeUser: false })
      );
      const pages = splitLinesToPages(lines);

      for (let index = 0; index < pages.length; index += 1) {
        const embed = new EmbedBuilder()
          .setColor('#2ECC71')
          .setTitle(`あなたの日次プレイ履歴 [${getModeLabel(mode)}]`)
          .setDescription(
            [
              reportType === 'bootstrap'
                ? `${label} のプレイ履歴（途中集計）`
                : `${label} のプレイ履歴`,
              ...summaryLines,
              `対象: ${formatNumber(sortedEntries.length)}件 / PP降順`,
              `ページ: ${index + 1}/${pages.length}`,
              '',
              pages[index].join('\n')
            ].join('\n')
          )
          .setTimestamp(new Date());

        await dmUser.send({ embeds: [embed] }).catch(() => null);
        sentCount += 1;
      }
    }
  }

  return sentCount;
}

async function sendDailyPlayHistoryReports({
  client,
  guildSettingsMap,
  entriesByMode,
  modes,
  label,
  reportType
}) {
  const memberCache = new Map();
  let sentCount = 0;

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    const channelId = resolveDailyHistoryChannelId(settings);
    if (!channelId) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    for (const mode of modes) {
      const allEntries = entriesByMode.get(mode) || [];
      const guildEntries = [];

      for (const entry of allEntries) {
        const member = await isGuildMember(guild, entry.discordId, memberCache);
        if (member) {
          guildEntries.push(entry);
        }
      }

      const sortedGuildEntries = sortDailyEntriesByPp(guildEntries);

      if (sortedGuildEntries.length === 0) {
        const noDataEmbed = new EmbedBuilder()
          .setColor('#95A5A6')
          .setTitle(`日次プレイ履歴 [${getModeLabel(mode)}]`)
          .setDescription(
            reportType === 'bootstrap'
              ? `${label} のプレイ履歴（途中集計）\n対象プレイはありませんでした。`
              : `${label} のプレイ履歴\n対象プレイはありませんでした。`
          )
          .setTimestamp(new Date());

        await channel.send({ embeds: [noDataEmbed] }).catch(() => null);
        sentCount += 1;
        continue;
      }

      const lines = sortedGuildEntries.map((entry, index) => buildDailyPlayLine(entry, index));
      const pages = splitLinesToPages(lines);

      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const embed = new EmbedBuilder()
          .setColor('#1ABC9C')
          .setTitle(`日次プレイ履歴 [${getModeLabel(mode)}]`)
          .setDescription(
            [
              reportType === 'bootstrap'
                ? `${label} のプレイ履歴（途中集計）`
                : `${label} のプレイ履歴`,
              `対象: ${formatNumber(sortedGuildEntries.length)}件 / PP降順`,
              `ページ: ${index + 1}/${pages.length}`,
              '',
              page.join('\n')
            ].join('\n')
          )
          .setTimestamp(new Date());

        await channel.send({ embeds: [embed] }).catch(() => null);
        sentCount += 1;
      }
    }
  }

  return sentCount;
}

async function runCycle(client) {
  if (isRunning) {
    log('osu! スナップショット収集をスキップ（前回処理が継続中）', 'info');
    return;
  }

  isRunning = true;

  try {
    let currentLinks = [];
    try {
      currentLinks = await listLinkedOsuUsers();
    } catch (error) {
      log(`osu! 連携ユーザー取得に失敗: ${error.message}`, 'error');
    }

    for (const link of currentLinks) {
      const discordId = String(link.discord_id || '').trim();
      const username = String(link.osu_username || '').trim();
      if (!discordId || !username) {
        continue;
      }

      try {
        await upsertTrackedOsuUser({
          discordId,
          osuUsername: username
        });
      } catch (error) {
        log(`osu! 追跡ユーザー更新失敗: ${discordId} - ${error.message}`, 'error');
      }
    }

    const trackedUsers = await listTrackedOsuUsers();
    if (trackedUsers.length === 0) {
      log('osu! 追跡ユーザーが0件のため、スナップショット収集をスキップ', 'info');
      return;
    }

    const modes = parseModes();
    const guildSettingsMap = new Map();
    for (const [guildId] of client.guilds.cache) {
      const settings = await getGuildOsuSettings(guildId);
      guildSettingsMap.set(guildId, settings);
    }

    const minimumMinutes = [...guildSettingsMap.values()]
      .map(settings => Number(settings.snapshot_interval_minutes || parseMinutes()))
      .filter(value => Number.isFinite(value) && value >= 10)
      .reduce((acc, value) => Math.min(acc, value), parseMinutes());

    const nowMs = Date.now();
    const collectNow = shouldCollectNow(minimumMinutes, nowMs);

    let savedCount = 0;
    let alertCount = 0;
    let milestoneCount = 0;
    let bestPlayCount = 0;

    if (collectNow) {
      for (const trackedUser of trackedUsers) {
        const discordId = String(trackedUser.discord_id || '').trim();
        const username = String(trackedUser.osu_username || '').trim();
        const trackedOsuUserId = toFiniteNumber(trackedUser.osu_user_id);

        if (!discordId || (!username && trackedOsuUserId === null)) {
          continue;
        }

        for (const mode of modes) {
          try {
            const lookupTarget = trackedOsuUserId !== null ? trackedOsuUserId : username;
            const user = await fetchOsuUser(lookupTarget, mode);
            const stats = user.statistics || {};
            const previous = await getLatestSnapshot({ osuUserId: user.id, mode });

            await upsertTrackedOsuUser({
              discordId,
              osuUserId: user.id,
              osuUsername: user.username
            });

            await saveOsuSnapshot({
              discordId,
              osuUserId: user.id,
              osuUsername: user.username,
              mode,
              pp: stats.pp,
              globalRank: stats.global_rank,
              countryRank: stats.country_rank,
              playTimeSeconds: stats.play_time,
              playCount: stats.play_count
            });

            savedCount += 1;

            if (previous) {
              alertCount += await sendGrowthAlertsToGuildChannels(
                client,
                guildSettingsMap,
                discordId,
                {
                user,
                mode,
                previous,
                currentStats: stats
              }
              );

              const ppMilestone = crossedPpMilestone(previous.pp, stats.pp);
              const rankMilestone = crossedRankMilestone(previous.global_rank, stats.global_rank);
              const milestoneEmbed = buildMilestoneEmbed({
                user,
                mode,
                ppMilestone,
                rankMilestone
              });

              milestoneCount += await sendToGuildAlertChannels(client, guildSettingsMap, discordId, milestoneEmbed);
            }

            const [bestScore] = await fetchBestScores(user.id, mode, 1);
            if (bestScore) {
              const previousBest = await getBestScoreRecord(user.id, mode);
              const currentBestPp = toFiniteNumber(bestScore.pp);
              const previousBestPp = toFiniteNumber(previousBest?.pp);
              const scoreChanged = Number(bestScore.id) !== Number(previousBest?.score_id);
              const ppIncreased =
                currentBestPp !== null &&
                (previousBestPp === null || currentBestPp > previousBestPp + 0.0001);

              await upsertBestScoreRecord({
                discordId,
                osuUserId: user.id,
                osuUsername: user.username,
                mode,
                scoreId: bestScore.id,
                pp: bestScore.pp,
                beatmapId: bestScore.beatmap?.id,
                beatmapTitle: `${bestScore.beatmapset?.artist || 'Unknown Artist'} - ${bestScore.beatmapset?.title || 'Unknown Title'} [${bestScore.beatmap?.version || 'Unknown Diff'}]`,
                accuracy: bestScore.accuracy,
                missCount: bestScore.statistics?.miss,
                maxCombo: bestScore.max_combo,
                mods: Array.isArray(bestScore.mods) ? bestScore.mods.join(',') : null
              });

              if (scoreChanged && ppIncreased) {
                await insertBestScoreEvent({
                  discordId,
                  osuUserId: user.id,
                  osuUsername: user.username,
                  mode,
                  scoreId: bestScore.id,
                  pp: bestScore.pp
                });

                const bestEmbed = buildBestPlayEmbed({
                  user,
                  mode,
                  bestScore,
                  previousRecord: previousBest
                });

                bestPlayCount += await sendToGuildAlertChannels(client, guildSettingsMap, discordId, bestEmbed);
              }
            }
          } catch (error) {
            log(`osu! 収集失敗: ${username} [${mode}] - ${error.message}`, 'error');
          }
        }
      }

      lastCollectionAt = nowMs;
    }

    const reportMode = getModeForReports(modes);
    await sendWeeklyReports(client, guildSettingsMap, trackedUsers, reportMode);

    const tickMinutes = 10;
    const nowMsForDaily = Date.now();
    const dailyOffsetHours = parseDailyHistoryTimezoneOffsetHours();
    const dailyWindow = resolveDailyHistoryWindow({
      nowMs: nowMsForDaily,
      tickMinutes,
      offsetHours: dailyOffsetHours,
      bootstrap: !hasRunDailyHistoryBootstrap
    });

    if (dailyWindow) {
      const shouldSkipByKey =
        dailyWindow.type === 'daily' && dailyHistorySentDateKeys.has(dailyWindow.dateKey);

      if (!shouldSkipByKey) {
        const recentLimit = parseDailyHistoryRecentLimit();
        const entriesByMode = await collectDailyPlayHistoryEntries({
          trackedUsers,
          modes,
          startMs: dailyWindow.startMs,
          endMs: dailyWindow.endMs,
          recentLimit
        });

        const dailySent = await sendDailyPlayHistoryReports({
          client,
          guildSettingsMap,
          entriesByMode,
          modes,
          label: dailyWindow.label,
          reportType: dailyWindow.type
        });
        const dailyDmSent = await sendDailyPlayHistoryDmReports({
          client,
          trackedUsers,
          entriesByMode,
          modes,
          label: dailyWindow.label,
          reportType: dailyWindow.type,
          startMs: dailyWindow.startMs,
          endMs: dailyWindow.endMs
        });

        if (dailyWindow.type === 'daily') {
          dailyHistorySentDateKeys.add(dailyWindow.dateKey);
        }

        log(
          `日次プレイ履歴送信: ${dailyWindow.label} / 種別 ${dailyWindow.type} / ギルド送信 ${dailySent}件 / DM送信 ${dailyDmSent}件`,
          'success'
        );
      }

      if (dailyWindow.type === 'bootstrap') {
        hasRunDailyHistoryBootstrap = true;
      }
    }

    const reminderCount = await sendGoalReminders(client);

    log(
      `osu! ジョブ完了: 保存 ${savedCount}件 / 成長通知 ${alertCount}件 / マイルストーン ${milestoneCount}件 / ベスト更新 ${bestPlayCount}件 / 目標リマインド ${reminderCount}件`,
      'success'
    );
  } catch (error) {
    log(`osu! スナップショット収集ジョブ失敗: ${error.message}`, 'error');
  } finally {
    isRunning = false;
  }
}

export function startOsuSnapshotScheduler(client) {
  if (schedulerTimer) {
    return;
  }

  const tickMinutes = 10;
  const intervalMs = tickMinutes * 60 * 1000;

  setTimeout(() => {
    runCycle(client).catch((error) => {
      log(`osu! 初回スナップショット実行失敗: ${error.message}`, 'error');
    });
  }, 10_000);

  schedulerTimer = setInterval(() => {
    runCycle(client).catch((error) => {
      log(`osu! 定期スナップショット実行失敗: ${error.message}`, 'error');
    });
  }, intervalMs);

  log(`osu! スナップショット定期収集を開始 (ジョブtick ${tickMinutes}分)`, 'success');
}
