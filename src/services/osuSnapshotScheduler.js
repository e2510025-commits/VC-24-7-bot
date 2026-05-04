import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getBestScoreRecord, upsertBestScoreRecord } from '../database/osuBestScores.js';
import { insertBestScoreEvent, listBestScoreEventsSince } from '../database/osuBestScoreEvents.js';
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
const IMPORTANT_BEST_UPDATE_PP_DELTA = 20;
const IMPORTANT_RANK_MILESTONE_THRESHOLD = 1000;
const IMPORTANT_PP_MILESTONE_THRESHOLD = 10000;
const MONTHLY_SUMMARY_RECENT_LIMIT = 100;
const dailyHistorySentDateKeys = new Set();
const monthlySummarySentKeys = new Set();
let hasRunDailyHistoryBootstrap = false;
const ROLE_ASSIGN_MODE = 'osu';
const PLAY_TIME_ROLE_TIERS = [
  { days: 1, name: '1day' },
  { days: 3, name: '3day' },
  { days: 5, name: '5day' },
  { days: 10, name: '10day' },
  { days: 30, name: '30day' },
  { days: 50, name: '50day' },
  { days: 100, name: '100day' }
];
const PP_ROLE_TIERS = [
  { pp: 100, name: '100pp' },
  { pp: 500, name: '500pp' },
  { pp: 1000, name: '1000pp' },
  { pp: 1500, name: '1500pp' },
  { pp: 2000, name: '2000pp' },
  { pp: 4000, name: '4000pp' },
  { pp: 5000, name: '5000pp' },
  { pp: 6000, name: '6000pp' },
  { pp: 7000, name: '7000pp' },
  { pp: 8000, name: '8000pp' },
  { pp: 9000, name: '9000pp' },
  { pp: 10000, name: '10000pp' }
];

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

function resolveMonthlySummaryWindow({ nowMs, tickMinutes, offsetHours }) {
  if (!isInDailyMidnightWindow(nowMs, tickMinutes, offsetHours)) {
    return null;
  }

  const shifted = new Date(nowMs + offsetHours * 60 * 60 * 1000);
  if (!Number.isFinite(shifted.getTime()) || shifted.getUTCDate() !== 1) {
    return null;
  }

  const currentMonthStartMs = startOfDayWithOffsetMs(nowMs, offsetHours);
  if (currentMonthStartMs === null) {
    return null;
  }

  const currentMonthStartShifted = new Date(currentMonthStartMs + offsetHours * 60 * 60 * 1000);
  const previousMonthStartShifted = new Date(Date.UTC(
    currentMonthStartShifted.getUTCFullYear(),
    currentMonthStartShifted.getUTCMonth() - 1,
    1
  ));
  const previousMonthStartMs = previousMonthStartShifted.getTime() - offsetHours * 60 * 60 * 1000;

  const label = `${previousMonthStartShifted.getUTCFullYear()}-${`${previousMonthStartShifted.getUTCMonth() + 1}`.padStart(2, '0')}`;

  return {
    monthKey: label,
    label,
    startMs: previousMonthStartMs,
    endMs: currentMonthStartMs
  };
}

function sanitizeFilenameSegment(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'unknown';
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildDailyEntriesCsv(entries, { includeUser = true } = {}) {
  const headers = includeUser
    ? ['rank', 'pp', 'user', 'title', 'score_url', 'played_at', 'is_first_seen_map']
    : ['rank', 'pp', 'title', 'score_url', 'played_at', 'is_first_seen_map'];

  const lines = [headers.join(',')];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const row = includeUser
      ? [
          index + 1,
          toFiniteNumber(entry.pp) === null ? '' : toFiniteNumber(entry.pp).toFixed(2),
          entry.osuUsername || `osu#${entry.osuUserId}`,
          entry.title,
          entry.scoreUrl || '',
          entry.playedAt || '',
          entry.isFirstSeenMap ? 'yes' : 'no'
        ]
      : [
          index + 1,
          toFiniteNumber(entry.pp) === null ? '' : toFiniteNumber(entry.pp).toFixed(2),
          entry.title,
          entry.scoreUrl || '',
          entry.playedAt || '',
          entry.isFirstSeenMap ? 'yes' : 'no'
        ];

    lines.push(row.map(escapeCsv).join(','));
  }

  return lines.join('\n');
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveTierName(tiers, value, key) {
  if (value === null) {
    return null;
  }

  let chosen = null;
  for (const tier of tiers) {
    if (value >= tier[key]) {
      chosen = tier.name;
    }
  }

  return chosen;
}

function buildRoleMap(guild, roleNames) {
  const map = new Map();
  for (const name of roleNames) {
    const role = guild.roles.cache.find(item => item.name === name);
    if (role) {
      map.set(name, role);
    }
  }
  return map;
}

function isManageableRole(role, botMember) {
  if (!role || role.managed || !botMember) {
    return false;
  }
  return role.position < botMember.roles.highest.position;
}

async function syncMemberRoleCategory(member, botMember, roleNames, desiredRoleName, label, discordId) {
  const roleMap = buildRoleMap(member.guild, roleNames);
  const manageableRoles = roleNames
    .map(name => roleMap.get(name))
    .filter(role => isManageableRole(role, botMember));
  const manageableRoleIds = manageableRoles.map(role => role.id);
  const desiredRole = desiredRoleName ? roleMap.get(desiredRoleName) : null;
  const desiredRoleId = desiredRole && isManageableRole(desiredRole, botMember)
    ? desiredRole.id
    : null;

  if (desiredRoleName && !desiredRole) {
    log(`osu! ロール未検出: ${member.guild.name} ${label} ${desiredRoleName}`, 'info');
  } else if (desiredRoleName && desiredRole && !desiredRoleId) {
    log(`osu! ロール権限不足: ${member.guild.name} ${label} ${desiredRoleName}`, 'info');
  }

  const removeRoleIds = manageableRoleIds.filter(
    id => id !== desiredRoleId && member.roles.cache.has(id)
  );

  if (removeRoleIds.length > 0) {
    await member.roles.remove(removeRoleIds).catch(error => {
      log(`osu! ロール削除失敗: ${discordId} ${label} - ${error.message}`, 'error');
    });
  }

  if (desiredRoleId && !member.roles.cache.has(desiredRoleId)) {
    await member.roles.add(desiredRoleId).catch(error => {
      log(`osu! ロール付与失敗: ${discordId} ${label} - ${error.message}`, 'error');
    });
  }
}

async function applyOsuTierRoles(client, discordId, stats) {
  const playTimeSeconds = toFiniteNumber(stats?.play_time);
  const pp = toFiniteNumber(stats?.pp);
  const playTimeDays = playTimeSeconds === null ? null : Math.floor(playTimeSeconds / DAY_MS);

  const playTimeRole = resolveTierName(PLAY_TIME_ROLE_TIERS, playTimeDays, 'days');
  const ppRole = resolveTierName(PP_ROLE_TIERS, pp, 'pp');

  for (const [, guild] of client.guilds.cache) {
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      continue;
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) {
      continue;
    }

    await syncMemberRoleCategory(
      member,
      botMember,
      PLAY_TIME_ROLE_TIERS.map(tier => tier.name),
      playTimeRole,
      'playtime',
      discordId
    );

    await syncMemberRoleCategory(
      member,
      botMember,
      PP_ROLE_TIERS.map(tier => tier.name),
      ppRole,
      'pp',
      discordId
    );
  }
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

function buildUserModeKey(discordId, mode) {
  return `${String(discordId || '').trim()}:${normalizeOsuMode(mode || 'osu')}`;
}

function formatExplorationText(exploration) {
  if (!exploration || !Number.isFinite(exploration.uniqueBeatmaps) || exploration.uniqueBeatmaps <= 0) {
    return 'N/A';
  }

  const rate = Number.isFinite(exploration.explorationRate) ? exploration.explorationRate : 0;
  return `${exploration.firstSeenBeatmaps}/${exploration.uniqueBeatmaps} (${rate.toFixed(1)}%)`;
}

function buildYesterdayComparisonComment(todaySummary, yesterdaySummary) {
  if (!todaySummary || !yesterdaySummary) {
    return '昨日比較データ不足';
  }

  const todayPp = toFiniteNumber(todaySummary.ppDelta) ?? 0;
  const yesterdayPp = toFiniteNumber(yesterdaySummary.ppDelta) ?? 0;
  const todayRank = toFiniteNumber(todaySummary.rankDelta) ?? 0;
  const yesterdayRank = toFiniteNumber(yesterdaySummary.rankDelta) ?? 0;
  const todayPlayTime = toFiniteNumber(todaySummary.playTimeDelta) ?? 0;
  const yesterdayPlayTime = toFiniteNumber(yesterdaySummary.playTimeDelta) ?? 0;

  const comparePp = todayPp - yesterdayPp;
  const compareRank = todayRank - yesterdayRank;
  const comparePlayTime = todayPlayTime - yesterdayPlayTime;

  const wins = [comparePp, compareRank, comparePlayTime].filter(value => Number.isFinite(value) && value > 0).length;
  const losses = [comparePp, compareRank, comparePlayTime].filter(value => Number.isFinite(value) && value < 0).length;

  if (wins > losses) {
    return '昨日より全体的に伸びています。現在の練習配分を継続しましょう。';
  }

  if (losses > wins) {
    return '昨日比で伸び幅が控えめです。得意譜面でリズムを作ると改善しやすいです。';
  }

  return '昨日と同程度の推移です。再現性は高いので、難度を少し上げる余地があります。';
}

function buildDailySummaryLines(summary, options = {}) {
  const exploration = options.exploration || null;
  const yesterdayComment = options.yesterdayComment || null;

  if (!summary) {
    const lines = [
      '今日のプレイ時間: N/A',
      '今日の増加順位: N/A',
      '今日の増加PP: N/A',
      `新規譜面開拓率: ${formatExplorationText(exploration)}`
    ];

    if (yesterdayComment) {
      lines.push(`昨日比コメント: ${yesterdayComment}`);
    }

    return lines;
  }

  const lines = [
    `今日のプレイ時間: ${formatMetricDelta('play_time', summary.playTimeDelta)}`,
    `今日の増加順位: ${formatMetricDelta('rank_improvement', summary.rankDelta)}`,
    `今日の増加PP: ${formatMetricDelta('pp', summary.ppDelta)}`,
    `新規譜面開拓率: ${formatExplorationText(exploration)}`
  ];

  if (yesterdayComment) {
    lines.push(`昨日比コメント: ${yesterdayComment}`);
  }

  return lines;
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
  const userModeStats = new Map();

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
        const historicalBeatmapIds = new Set();
        const todayUniqueBeatmapIds = new Set();
        let firstSeenBeatmaps = 0;
        let totalPlays = 0;

        const modeEntries = [];

        for (const score of scores || []) {
          const playedAt =
            score?.ended_at ||
            score?.created_at ||
            score?.played_at ||
            score?.started_at;
          const playedMs = new Date(playedAt).getTime();
          if (!Number.isFinite(playedMs)) {
            continue;
          }

          const beatmapIdRaw = toFiniteNumber(score?.beatmap?.id);
          const beatmapId = beatmapIdRaw === null ? null : Math.trunc(beatmapIdRaw);

          if (playedMs < startMs) {
            if (beatmapId !== null) {
              historicalBeatmapIds.add(beatmapId);
            }
            continue;
          }

          if (playedMs >= endMs) {
            continue;
          }

          let isFirstSeenMap = false;
          if (beatmapId !== null) {
            const hasHistory = historicalBeatmapIds.has(beatmapId);
            const seenToday = todayUniqueBeatmapIds.has(beatmapId);
            if (!hasHistory && !seenToday) {
              isFirstSeenMap = true;
              firstSeenBeatmaps += 1;
            }
            todayUniqueBeatmapIds.add(beatmapId);
          }

          totalPlays += 1;

          const scoreId = toFiniteNumber(score?.id);
          const scoreMode = normalizeOsuMode(score?.mode || mode);
          const scoreUrl =
            scoreId === null
              ? null
              : `https://osu.ppy.sh/scores/${scoreMode}/${Math.trunc(scoreId)}`;

          modeEntries.push({
            discordId,
            osuUserId: trackedOsuUserId,
            osuUsername: String(score?.user?.username || username || '').trim(),
            mode,
            pp: score?.pp,
            playedAt,
            playedMs,
            beatmapId,
            isFirstSeenMap,
            title: normalizeDailyPlayTitle(score),
            scoreUrl
          });
        }

        for (const entry of modeEntries) {
          entriesByMode.get(mode).push(entry);
        }

        const uniqueBeatmaps = todayUniqueBeatmapIds.size;
        const explorationRate = uniqueBeatmaps > 0 ? (firstSeenBeatmaps / uniqueBeatmaps) * 100 : null;
        userModeStats.set(buildUserModeKey(discordId, mode), {
          totalPlays,
          uniqueBeatmaps,
          firstSeenBeatmaps,
          explorationRate
        });
      } catch (error) {
        log(`日次プレイ履歴取得失敗: ${username || trackedOsuUserId} [${mode}] - ${error.message}`, 'error');
      }
    }
  }

  return {
    entriesByMode,
    userModeStats
  };
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
  userModeStats,
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
      const exploration = userModeStats.get(buildUserModeKey(discordId, mode)) || null;
      const summary = await buildDailyUserModeSummary({
        osuUserId: target.osu_user_id,
        mode,
        startMs,
        endMs
      });

      const yesterdaySummary = await buildDailyUserModeSummary({
        osuUserId: target.osu_user_id,
        mode,
        startMs: startMs - DAY_MS,
        endMs: startMs
      });

      const yesterdayComment = buildYesterdayComparisonComment(summary, yesterdaySummary);

      const summaryLines = buildDailySummaryLines(summary, {
        exploration,
        yesterdayComment
      });

      const csvFileName = `daily-history-${sanitizeFilenameSegment(discordId)}-${sanitizeFilenameSegment(mode)}-${sanitizeFilenameSegment(label)}.csv`;
      const csvContent = buildDailyEntriesCsv(sortedEntries, { includeUser: false });
      const csvAttachment = sortedEntries.length > 0
        ? new AttachmentBuilder(Buffer.from(csvContent, 'utf8'), { name: csvFileName })
        : null;

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

        const files = index === 0 && csvAttachment ? [csvAttachment] : [];
        await dmUser.send({ embeds: [embed], files }).catch(() => null);
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
      const csvFileName = `daily-history-${sanitizeFilenameSegment(guildId)}-${sanitizeFilenameSegment(mode)}-${sanitizeFilenameSegment(label)}.csv`;
      const csvContent = buildDailyEntriesCsv(sortedGuildEntries, { includeUser: true });
      const csvAttachment = sortedGuildEntries.length > 0
        ? new AttachmentBuilder(Buffer.from(csvContent, 'utf8'), { name: csvFileName })
        : null;

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

        const files = index === 0 && csvAttachment ? [csvAttachment] : [];
        await channel.send({ embeds: [embed], files }).catch(() => null);
        sentCount += 1;
      }
    }
  }

  return sentCount;
}

function resolveMonthlySummaryChannelId(settings) {
  return (
    settings.daily_history_channel_id ||
    settings.report_channel_id ||
    settings.alert_channel_id ||
    null
  );
}

async function sendMonthlySummaries({
  client,
  guildSettingsMap,
  trackedUsers,
  modes,
  monthlyWindow
}) {
  const memberCache = new Map();
  let sentCount = 0;

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    const monthKey = `${guildId}:${monthlyWindow.monthKey}`;
    if (monthlySummarySentKeys.has(monthKey)) {
      continue;
    }

    const channelId = resolveMonthlySummaryChannelId(settings);
    if (!channelId) {
      monthlySummarySentKeys.add(monthKey);
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

    const guildTrackedUsers = [];
    for (const trackedUser of trackedUsers) {
      const discordId = String(trackedUser.discord_id || '').trim();
      if (!discordId) {
        continue;
      }

      const member = await isGuildMember(guild, discordId, memberCache);
      if (member) {
        guildTrackedUsers.push(trackedUser);
      }
    }

    if (guildTrackedUsers.length === 0) {
      monthlySummarySentKeys.add(monthKey);
      continue;
    }

    for (const mode of modes) {
      const mapCounts = new Map();
      let totalPpDelta = 0;
      let totalRankDelta = 0;
      let totalPlayTimeDelta = 0;
      let contributors = 0;
      let highestUpdate = null;

      for (const trackedUser of guildTrackedUsers) {
        const discordId = String(trackedUser.discord_id || '').trim();
        const username = String(trackedUser.osu_username || '').trim();
        const osuUserId = toFiniteNumber(trackedUser.osu_user_id);
        const lookupTarget = osuUserId !== null ? osuUserId : username;

        if (!lookupTarget) {
          continue;
        }

        try {
          const scores = await fetchRecentScores(lookupTarget, mode, MONTHLY_SUMMARY_RECENT_LIMIT);
          for (const score of scores || []) {
            const playedMs = new Date(score?.ended_at || score?.created_at).getTime();
            if (!Number.isFinite(playedMs) || playedMs < monthlyWindow.startMs || playedMs >= monthlyWindow.endMs) {
              continue;
            }

            const title = normalizeDailyPlayTitle(score);
            mapCounts.set(title, (mapCounts.get(title) || 0) + 1);
          }
        } catch (error) {
          log(`月次サマリー recent取得失敗: ${lookupTarget} [${mode}] - ${error.message}`, 'error');
        }

        if (osuUserId === null) {
          continue;
        }

        try {
          const baseline = await getClosestSnapshotBefore({
            osuUserId,
            mode,
            beforeDate: new Date(monthlyWindow.startMs)
          });
          const latest = await getClosestSnapshotBefore({
            osuUserId,
            mode,
            beforeDate: new Date(monthlyWindow.endMs)
          });

          if (baseline && latest) {
            const ppDelta = computeGrowthDelta('pp', baseline.pp, latest.pp);
            const rankDelta = computeGrowthDelta('rank_improvement', baseline.global_rank, latest.global_rank);
            const playTimeDelta = computeGrowthDelta('play_time', baseline.play_time_seconds, latest.play_time_seconds);

            if (toFiniteNumber(ppDelta) !== null) totalPpDelta += ppDelta;
            if (toFiniteNumber(rankDelta) !== null) totalRankDelta += rankDelta;
            if (toFiniteNumber(playTimeDelta) !== null) totalPlayTimeDelta += playTimeDelta;
            contributors += 1;
          }

          const events = await listBestScoreEventsSince({
            osuUserId,
            mode,
            sinceDate: new Date(monthlyWindow.startMs),
            limit: 2000
          });

          for (const event of events) {
            const recordedMs = new Date(event.recorded_at).getTime();
            if (!Number.isFinite(recordedMs) || recordedMs < monthlyWindow.startMs || recordedMs >= monthlyWindow.endMs) {
              continue;
            }

            const eventPp = toFiniteNumber(event.pp);
            if (eventPp === null) {
              continue;
            }

            if (!highestUpdate || eventPp > highestUpdate.pp) {
              highestUpdate = {
                pp: eventPp,
                discordId,
                osuUsername: event.osu_username || username || `osu#${osuUserId}`,
                scoreId: toFiniteNumber(event.score_id),
                recordedAt: event.recorded_at
              };
            }
          }
        } catch (error) {
          log(`月次サマリー集計失敗: osuUserId=${osuUserId} [${mode}] - ${error.message}`, 'error');
        }
      }

      const mostPlayed = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0] || null;
      const hasData = mostPlayed || highestUpdate || contributors > 0;

      const embed = new EmbedBuilder()
        .setColor('#E84393')
        .setTitle(`月次まとめ [${getModeLabel(mode)}]`)
        .setDescription([
          `${monthlyWindow.label} の集計結果`,
          `対象ユーザー: ${formatNumber(guildTrackedUsers.length)}人`,
          `注: 譜面集計は recent ${MONTHLY_SUMMARY_RECENT_LIMIT} 件ベース`
        ].join('\n'))
        .setTimestamp(new Date());

      if (!hasData) {
        embed.addFields({
          name: '結果',
          value: '対象データがありませんでした',
          inline: false
        });

        await channel.send({ embeds: [embed] }).catch(() => null);
        sentCount += 1;
        continue;
      }

      embed.addFields(
        {
          name: '合計増分',
          value: [
            `PP: ${formatMetricDelta('pp', totalPpDelta)}`,
            `順位: ${formatMetricDelta('rank_improvement', totalRankDelta)}`,
            `プレイ時間: ${formatMetricDelta('play_time', totalPlayTimeDelta)}`,
            `有効ユーザー: ${formatNumber(contributors)}人`
          ].join('\n'),
          inline: true
        },
        {
          name: '最多プレイ譜面',
          value: mostPlayed ? `${mostPlayed[0]}\n${formatNumber(mostPlayed[1])}回` : 'N/A',
          inline: true
        },
        {
          name: '最高更新',
          value: highestUpdate
            ? [
                `${highestUpdate.osuUsername} (${formatNumber(highestUpdate.pp)}pp)`,
                highestUpdate.scoreId !== null
                  ? `https://osu.ppy.sh/scores/${normalizeOsuMode(mode)}/${Math.trunc(highestUpdate.scoreId)}`
                  : 'スコアリンクなし',
                toDiscordTimestamp(highestUpdate.recordedAt)
              ].join('\n')
            : 'N/A',
          inline: false
        }
      );

      await channel.send({ embeds: [embed] }).catch(() => null);
      sentCount += 1;
    }

    monthlySummarySentKeys.add(monthKey);
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

            if (mode === ROLE_ASSIGN_MODE) {
              await applyOsuTierRoles(client, discordId, stats);
            }

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
        const dailyHistoryData = await collectDailyPlayHistoryEntries({
          trackedUsers,
          modes,
          startMs: dailyWindow.startMs,
          endMs: dailyWindow.endMs,
          recentLimit
        });
        const entriesByMode = dailyHistoryData.entriesByMode;
        const userModeStats = dailyHistoryData.userModeStats;

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
          userModeStats,
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

    const monthlyWindow = resolveMonthlySummaryWindow({
      nowMs: nowMsForDaily,
      tickMinutes,
      offsetHours: dailyOffsetHours
    });

    if (monthlyWindow) {
      const monthlySent = await sendMonthlySummaries({
        client,
        guildSettingsMap,
        trackedUsers,
        modes,
        monthlyWindow
      });

      if (monthlySent > 0) {
        log(`月次まとめ送信: ${monthlyWindow.label} / 送信 ${monthlySent}件`, 'success');
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
