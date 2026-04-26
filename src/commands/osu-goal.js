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

function formatRemainingDays(endAt) {
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(end)) {
    return 'N/A';
  }

  const diff = end - Date.now();
  const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
  return days >= 0 ? `${days}日` : '期限切れ';
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
          '❌ ユーザー名を指定するか、先に /osu-link username:<osu名> で連携してください'
        );
      }

      const user = await fetchOsuUser(targetUsername, mode);
      const stats = user.statistics || {};
      const baseline = getMetricCurrentValue(metric, stats);

      if (!Number.isFinite(baseline)) {
        return interaction.editReply('❌ 現在値を取得できないため目標設定できませんでした');
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
        .setTitle('osu! 目標を設定しました')
        .setDescription(`${user.username} [${getModeLabel(mode)}]`)
        .addFields(
          { name: '指標', value: metricLabel(metric), inline: true },
          { name: '目標', value: formatMetricDelta(metric, target), inline: true },
          { name: '期限', value: toDiscordTimestamp(goal.end_at), inline: false }
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'status') {
      const modeOption = interaction.options.getString('mode');
      const mode = modeOption ? normalizeOsuMode(modeOption) : null;
      const goals = await listActiveGoals(interaction.user.id, mode);

      if (goals.length === 0) {
        return interaction.editReply('❌ 有効な目標がありません。/osu-goal set で設定してください');
      }

      const lines = [];

      for (const goal of goals) {
        try {
          const user = await fetchOsuUser(String(goal.osu_user_id), goal.mode);
          const stats = user.statistics || {};
          const current = getMetricCurrentValue(goal.metric, stats);
          const progress = goalProgress(goal.metric, goal.baseline_value, current, goal.target_value);

          lines.push(
            `• ${goal.osu_username} [${getModeLabel(goal.mode)}] ${metricLabel(goal.metric)}\n` +
              `  進捗: ${progress.achieved === null ? 'N/A' : formatMetricDelta(goal.metric, progress.achieved)} / ${formatMetricDelta(goal.metric, goal.target_value)}\n` +
              `  達成率: ${formatRatio(progress.ratio)} / 残り: ${formatRemainingDays(goal.end_at)}`
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
          lines.push(`• ${goal.osu_username} [${getModeLabel(goal.mode)}] ${metricLabel(goal.metric)}\n  進捗取得失敗: ${error.message}`);
        }
      }

      const embed = new EmbedBuilder()
        .setColor('#F1C40F')
        .setTitle('osu! 目標進捗')
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
        return interaction.editReply('❌ 解除対象の目標がありませんでした');
      }

      return interaction.editReply(`✅ ${cleared}件の目標を解除しました`);
    }

    return interaction.editReply('❌ 不明なサブコマンドです');
  } catch (error) {
    log(`/osu-goal エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ 目標処理中にエラーが発生しました');
  }
}
