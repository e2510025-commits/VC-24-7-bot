import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { listLinkedOsuUsers } from '../database/supabase.js';
import { getClosestSnapshotBefore, getSnapshotsSince, saveOsuSnapshot } from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchOsuUser,
  formatNumber,
  getModeLabel,
  normalizeOsuMode
} from '../utils/osuApi.js';
import { PERIOD_MAP, getPeriodLabel } from '../utils/osuGrowthUtils.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const PERIOD_CHOICES = [
  { name: '1week', value: '1week' },
  { name: '1month', value: '1month' }
];

export const data = new SlashCommandBuilder()
  .setName('osu-league')
  .setDescription('サーバー内フレンドリーグを表示します')
  .addStringOption(option =>
    option
      .setName('period')
      .setDescription('リーグ期間')
      .addChoices(...PERIOD_CHOICES)
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

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function calcLeaguePoints({ ppDelta, rankGain, activeDays, playCountDelta }) {
  const ppScore = Math.max(0, toFiniteNumber(ppDelta) || 0) * 2;
  const rankScore = Math.max(0, toFiniteNumber(rankGain) || 0) / 100;
  const activeScore = Math.max(0, toFiniteNumber(activeDays) || 0) * 3;
  const playScore = Math.max(0, toFiniteNumber(playCountDelta) || 0) * 0.1;
  return ppScore + rankScore + activeScore + playScore;
}

function uniqueActiveDays(snapshots) {
  const set = new Set();
  for (const snapshot of snapshots) {
    const key = new Date(snapshot.captured_at).toISOString().slice(0, 10);
    set.add(key);
  }
  return set.size;
}

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guild) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    const periodKey = interaction.options.getString('period') || '1week';
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const topCount = interaction.options.getInteger('top') || 10;
    const period = PERIOD_MAP[periodKey] || PERIOD_MAP['1week'];

    const allLinks = await listLinkedOsuUsers();
    if (allLinks.length === 0) {
      return interaction.editReply(translate(lang, 'osu.league.noLinks'));
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
      return interaction.editReply(translate(lang, 'osu.league.noGuildLinks'));
    }

    const cutoffDate = new Date(Date.now() - period.ms);
    const rows = [];

    for (const link of guildLinks) {
      const username = String(link.osu_username || '').trim();
      if (!username) {
        continue;
      }

      try {
        const user = await fetchOsuUser(username, mode);
        const stats = user.statistics || {};

        const previous = await getClosestSnapshotBefore({
          osuUserId: user.id,
          mode,
          beforeDate: cutoffDate
        });

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

        if (!previous) {
          continue;
        }

        const snapshots = await getSnapshotsSince({
          osuUserId: user.id,
          mode,
          sinceDate: cutoffDate,
          untilDate: new Date()
        });

        const currentPp = toFiniteNumber(stats.pp);
        const previousPp = toFiniteNumber(previous.pp);
        const ppDelta =
          currentPp !== null && previousPp !== null
            ? currentPp - previousPp
            : null;

        const currentRank = toFiniteNumber(stats.global_rank);
        const previousRank = toFiniteNumber(previous.global_rank);
        const rankGain =
          currentRank !== null && previousRank !== null && currentRank > 0 && previousRank > 0
            ? previousRank - currentRank
            : null;

        const currentPlayCount = toFiniteNumber(stats.play_count);
        const previousPlayCount = toFiniteNumber(previous.play_count);
        const playCountDelta =
          currentPlayCount !== null && previousPlayCount !== null
            ? currentPlayCount - previousPlayCount
            : null;

        const activeDays = uniqueActiveDays(snapshots);

        const points = calcLeaguePoints({
          ppDelta,
          rankGain,
          activeDays,
          playCountDelta
        });

        rows.push({
          discordId: link.discord_id,
          osuUsername: user.username,
          ppDelta,
          rankGain,
          activeDays,
          points
        });
      } catch (error) {
        log(`/osu-league 解析失敗: ${username} [${mode}] - ${error.message}`, 'error');
      }
    }

    const sorted = rows
      .filter(row => Number.isFinite(row.points))
      .sort((a, b) => b.points - a.points)
      .slice(0, topCount);

    if (sorted.length === 0) {
      return interaction.editReply(translate(lang, 'osu.league.noData'));
    }

    const embed = new EmbedBuilder()
      .setColor('#6C5CE7')
      .setTitle(translate(lang, 'osuLeague.title', { mode: getModeLabel(mode) }))
      .setDescription(translate(lang, 'osuLeague.description', {
        period: getPeriodLabel(periodKey, lang)
      }))
      .addFields({
        name: translate(lang, 'osuLeague.topTitle', { count: sorted.length }),
        value: sorted
          .map((row, index) => {
            const pp = toFiniteNumber(row.ppDelta);
            const rank = toFiniteNumber(row.rankGain);
            return translate(lang, 'osuLeague.rowFormat', {
              rankIndex: index + 1,
              mention: `<@${row.discordId}>`,
              username: row.osuUsername,
              points: row.points.toFixed(2),
              pp: pp === null ? 'N/A' : `${pp >= 0 ? '+' : '-'}${Math.abs(pp).toFixed(2)}`,
              rank: rank === null
                ? 'N/A'
                : (rank >= 0
                  ? `↑${formatNumber(Math.trunc(rank))}`
                  : `↓${formatNumber(Math.trunc(Math.abs(rank)))}`),
              activeDays: formatNumber(row.activeDays)
            });
          })
          .join('\n')
      })
      .setTimestamp(new Date());

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-league エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.league.failed'));
  }
}
