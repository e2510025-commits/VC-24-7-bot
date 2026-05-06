import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { clearActiveGoals, listActiveGoals, upsertActiveGoal } from '../database/osuGoals.js';
import { saveOsuSnapshot } from '../database/osuSnapshots.js';
import { OsuApiError, fetchOsuUser, getModeLabel, normalizeOsuMode, toDiscordTimestamp } from '../utils/osuApi.js';
import {
  GOAL_METRICS,
  formatMetricDelta,
  goalProgress,
  metricLabel
} from '../utils/osuGrowthUtils.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

function getMetricCurrentValue(metric, stats) {
  switch (metric) {
    case 'pp':
      return Number(stats?.pp);
    case 'play_time':
      return Number(stats?.play_time);
    case 'play_count':
      return Number(stats?.play_count);
    case 'rank_improvement':
      return Number(stats?.global_rank);
    default:
      return NaN;
  }
}

function formatRatio(ratio) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }
  return `${Math.max(0, numeric).toFixed(1)}%`;
}

function formatRemainingDays(endAt, lang) {
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(end)) {
    return 'N/A';
  }

  const diff = end - Date.now();
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  return days >= 0
    ? translate(lang, 'osuGoal.remainingDays', { days })
    : translate(lang, 'osuGoal.expired');
}

async function resolveTargetUsername(interaction, usernameOverride = null) {
  const input = usernameOverride ?? interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

export const data = new SlashCommandBuilder()
  .setName('osu-goal')
  .setDescription('osu!目標を設定・確認します')
  .addSubcommand(subcommand =>
    subcommand
      .setName('set')
      .setDescription('目標を設定します')
      .addStringOption(option =>
        option
          .setName('metric')
          .setDescription('目標指標')
          .addChoices(...GOAL_METRICS)
          .setRequired(true)
      )
      .addNumberOption(option =>
        option
          .setName('target')
          .setDescription('目標値（増加量）')
          .setMinValue(0.01)
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('days')
          .setDescription('達成期限（日数）')
          .setMinValue(1)
          .setMaxValue(365)
          .setRequired(true)
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
      .addStringOption(option =>
        option
          .setName('username')
          .setDescription('対象osu!ユーザー名（省略時は連携済みユーザー）')
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('status')
      .setDescription('現在の目標進捗を表示します')
      .addStringOption(option =>
        option
          .setName('mode')
          .setDescription('対象モード（省略時は全モード）')
          .addChoices(
            { name: 'std', value: 'osu' },
            { name: 'mania', value: 'mania' },
            { name: 'catch', value: 'fruits' },
            { name: 'taiko', value: 'taiko' }
          )
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('clear')
      .setDescription('目標を解除します')
      .addStringOption(option =>
        option
          .setName('metric')
          .setDescription('解除する指標（省略時は全指標）')
          .addChoices(...GOAL_METRICS)
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('mode')
          .setDescription('対象モード（省略時は全モード）')
          .addChoices(
            { name: 'std', value: 'osu' },
            { name: 'mania', value: 'mania' },
            { name: 'catch', value: 'fruits' },
            { name: 'taiko', value: 'taiko' }
          )
          .setRequired(false)
      )
  );

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set') {
      const metric = interaction.options.getString('metric', true);
      const target = interaction.options.getNumber('target', true);
      const days = interaction.options.getInteger('days', true);
      const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
      const targetUsername = await resolveTargetUsername(interaction);

      if (!targetUsername) {
        return interaction.editReply(
          translate(lang, 'osu.requireLink')
        );
      }

      const user = await fetchOsuUser(targetUsername, mode);
      const stats = user.statistics || {};
      const baseline = getMetricCurrentValue(metric, stats);

      if (!Number.isFinite(baseline)) {
        return interaction.editReply(translate(lang, 'osu.goal.noBaseline'));
      }

      const goal = await upsertActiveGoal({
        discordId: interaction.user.id,
        osuUserId: user.id,
        osuUsername: user.username,
        mode,
        metric,
        targetValue: target,
        baselineValue: baseline,
        periodDays: days
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

      const embed = new EmbedBuilder()
        .setColor('#F39C12')
        .setTitle(translate(lang, 'osuGoal.setTitle'))
        .setDescription(translate(lang, 'osuGoal.setDescription', {
          username: user.username,
          mode: getModeLabel(mode)
        }))
        .addFields(
            { name: translate(lang, 'osuGoal.metricLabel'), value: metricLabel(metric, lang), inline: true },
            { name: translate(lang, 'osuGoal.targetLabel'), value: formatMetricDelta(metric, target, lang), inline: true },
          { name: translate(lang, 'osuGoal.deadlineLabel'), value: toDiscordTimestamp(goal.end_at), inline: false }
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'status') {
      const modeOption = interaction.options.getString('mode');
      const mode = modeOption ? normalizeOsuMode(modeOption) : null;
      const goals = await listActiveGoals(interaction.user.id, mode);

      if (goals.length === 0) {
        return interaction.editReply(translate(lang, 'osu.goal.noActive'));
      }

      const lines = [];

      for (const goal of goals) {
        try {
          const user = await fetchOsuUser(String(goal.osu_user_id), goal.mode);
          const stats = user.statistics || {};
          const current = getMetricCurrentValue(goal.metric, stats);
          const progress = goalProgress(goal.metric, goal.baseline_value, current, goal.target_value);

          lines.push(
            translate(lang, 'osuGoal.statusLine', {
              username: goal.osu_username,
              mode: getModeLabel(goal.mode),
                metric: metricLabel(goal.metric, lang),
                achieved: progress.achieved === null ? 'N/A' : formatMetricDelta(goal.metric, progress.achieved, lang),
                target: formatMetricDelta(goal.metric, goal.target_value, lang),
              ratio: formatRatio(progress.ratio),
              remaining: formatRemainingDays(goal.end_at, lang)
            })
          );

          await saveOsuSnapshot({
            discordId: interaction.user.id,
            osuUserId: user.id,
            osuUsername: user.username,
            mode: goal.mode,
            pp: stats.pp,
            globalRank: stats.global_rank,
            countryRank: stats.country_rank,
            playTimeSeconds: stats.play_time,
            playCount: stats.play_count
          });
        } catch (error) {
          lines.push(translate(lang, 'osuGoal.statusErrorLine', {
            username: goal.osu_username,
            mode: getModeLabel(goal.mode),
            metric: metricLabel(goal.metric, lang),
            error: error.message
          }));
        }
      }

      const embed = new EmbedBuilder()
        .setColor('#F1C40F')
        .setTitle(translate(lang, 'osuGoal.statusTitle'))
        .setDescription(lines.join('\n'))
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'clear') {
      const metric = interaction.options.getString('metric');
      const modeOption = interaction.options.getString('mode');
      const mode = modeOption ? normalizeOsuMode(modeOption) : null;
      const cleared = await clearActiveGoals(interaction.user.id, mode, metric);

      if (cleared === 0) {
        return interaction.editReply(translate(lang, 'osu.goal.noClear'));
      }

      return interaction.editReply(translate(lang, 'osu.goal.cleared', { count: cleared }));
    }

    return interaction.editReply(translate(lang, 'common.unknownSubcommand'));
  } catch (error) {
    log(`/osu-goal エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(
      translate(lang, 'osu.goal.failed', { error: error.message })
    );
  }
}
