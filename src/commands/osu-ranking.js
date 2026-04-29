import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { listLinkedOsuUsers } from '../database/supabase.js';
import { getClosestSnapshotBefore, saveOsuSnapshot } from '../database/osuSnapshots.js';
import { fetchOsuUser, getModeLabel, normalizeOsuMode } from '../utils/osuApi.js';
import {
  PERIOD_MAP,
  RANK_METRICS,
  computeGrowthDelta,
  formatMetricDelta,
  formatMetricValue,
  getSnapshotValue,
  getStatsValue,
  metricLabel
} from '../utils/osuGrowthUtils.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const PERIOD_CHOICES = [
  { name: '24h', value: '24h' },
  { name: '1week', value: '1week' },
  { name: '1month', value: '1month' }
];

export const data = new SlashCommandBuilder()
  .setName('osu-ranking')
  .setDescription('サーバー内のosu!成長ランキングを表示します')
  .addStringOption(option =>
    option
      .setName('period')
      .setDescription('比較期間')
      .addChoices(...PERIOD_CHOICES)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('metric')
      .setDescription('ランキング指標')
      .addChoices(...RANK_METRICS)
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

function resolveMetricPair(metric, stats, snapshot) {
  if (metric === 'rank_improvement') {
    return {
      previous: getSnapshotValue(snapshot, 'global_rank'),
      current: getStatsValue(stats, 'global_rank')
    };
  }

  return {
    previous: getSnapshotValue(snapshot, metric),
    current: getStatsValue(stats, metric)
  };
}

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guild) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    const periodKey = interaction.options.getString('period') || '1week';
    const metric = interaction.options.getString('metric') || 'pp';
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const topCount = interaction.options.getInteger('top') || 10;

    const period = PERIOD_MAP[periodKey];
    if (!period) {
      return interaction.editReply(translate(lang, 'osu.ranking.invalidPeriod'));
    }

    const allLinks = await listLinkedOsuUsers();
    if (allLinks.length === 0) {
      return interaction.editReply(translate(lang, 'osu.ranking.noLinks'));
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
      return interaction.editReply(translate(lang, 'osu.ranking.noGuildLinks'));
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
        const snapshot = await getClosestSnapshotBefore({
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

        if (!snapshot) {
          continue;
        }

        const pair = resolveMetricPair(metric, stats, snapshot);
        const delta = computeGrowthDelta(metric, pair.previous, pair.current);

        if (delta === null) {
          continue;
        }

        rows.push({
          discordId: link.discord_id,
          osuUsername: user.username,
          delta,
          currentValue: pair.current
        });
      } catch (error) {
        log(`/osu-ranking 解析失敗: ${username} [${mode}] - ${error.message}`, 'error');
      }
    }

    const sorted = rows
      .filter(item => Number.isFinite(item.delta))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, topCount);

    if (sorted.length === 0) {
      return interaction.editReply(translate(lang, 'osu.ranking.noData'));
    }

    const embed = new EmbedBuilder()
      .setColor('#00B894')
      .setTitle(`osu! サーバー成長ランキング [${getModeLabel(mode)}]`)
      .setDescription(`${period.label} / 指標: ${metricLabel(metric)}`)
      .addFields({
        name: `TOP ${sorted.length}`,
        value: sorted
          .map((item, index) => {
            const mention = `<@${item.discordId}>`;
            return `${index + 1}. ${mention} (${item.osuUsername})\n  変化: ${formatMetricDelta(metric, item.delta)} / 現在: ${formatMetricValue(metric === 'rank_improvement' ? 'global_rank' : metric, item.currentValue)}`;
          })
          .join('\n')
      })
      .setTimestamp(new Date());

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-ranking エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');
    return interaction.editReply(translate(lang, 'osu.ranking.failed'));
  }
}
