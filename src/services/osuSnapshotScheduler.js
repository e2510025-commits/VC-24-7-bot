import { EmbedBuilder } from 'discord.js';
import { getBestScoreRecord, upsertBestScoreRecord } from '../database/osuBestScores.js';
import { listGoalsExpiringSoon, markGoalReminderSent } from '../database/osuGoals.js';
import { getGuildOsuSettings } from '../database/osuGuildSettings.js';
import { listLinkedOsuUsers } from '../database/supabase.js';
import {
  getClosestSnapshotBefore,
  getLatestSnapshot,
  getLatestSnapshotsByDiscordIds,
  saveOsuSnapshot
} from '../database/osuSnapshots.js';
import {
  fetchBestScores,
  fetchOsuUser,
  formatNumber,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import {
  PERIOD_MAP,
  computeGrowthDelta,
  formatMetricDelta,
  metricLabel
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

function buildBestPlayEmbed({ user, mode, bestScore, previousRecord }) {
  const ppNow = toFiniteNumber(bestScore?.pp);
  const ppBefore = toFiniteNumber(previousRecord?.pp);
  const scoreId = bestScore?.id;
  const beatmap = bestScore?.beatmap || {};
  const beatmapset = bestScore?.beatmapset || {};
  const title = `${beatmapset.artist || 'Unknown Artist'} - ${beatmapset.title || 'Unknown Title'} [${beatmap.version || 'Unknown Diff'}]`;
  const scoreUrl = scoreId
    ? `https://osu.ppy.sh/scores/${bestScore.mode || mode}/${scoreId}`
    : `https://osu.ppy.sh/users/${user.id}`;

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
            : formatMetricDelta('pp', ppNow - ppBefore),
        inline: true
      }
    )
    .setTimestamp(new Date());
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

async function runCycle(client) {
  if (isRunning) {
    log('osu! スナップショット収集をスキップ（前回処理が継続中）', 'info');
    return;
  }

  isRunning = true;

  try {
    const links = await listLinkedOsuUsers();
    if (links.length === 0) {
      log('osu! 連携ユーザーが0件のため、スナップショット収集をスキップ', 'info');
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
      for (const link of links) {
        const username = String(link.osu_username || '').trim();
        if (!username) {
          continue;
        }

        for (const mode of modes) {
          try {
            const user = await fetchOsuUser(username, mode);
            const stats = user.statistics || {};
            const previous = await getLatestSnapshot({ osuUserId: user.id, mode });

            await saveOsuSnapshot({
              discordId: link.discord_id,
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
                link.discord_id,
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

              milestoneCount += await sendToGuildAlertChannels(client, guildSettingsMap, link.discord_id, milestoneEmbed);
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
                discordId: link.discord_id,
                osuUserId: user.id,
                osuUsername: user.username,
                mode,
                scoreId: bestScore.id,
                pp: bestScore.pp,
                beatmapId: bestScore.beatmap?.id,
                beatmapTitle: `${bestScore.beatmapset?.artist || 'Unknown Artist'} - ${bestScore.beatmapset?.title || 'Unknown Title'} [${bestScore.beatmap?.version || 'Unknown Diff'}]`
              });

              if (scoreChanged && ppIncreased) {
                const bestEmbed = buildBestPlayEmbed({
                  user,
                  mode,
                  bestScore,
                  previousRecord: previousBest
                });

                bestPlayCount += await sendToGuildAlertChannels(client, guildSettingsMap, link.discord_id, bestEmbed);
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
    await sendWeeklyReports(client, guildSettingsMap, links, reportMode);
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
