import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { getGuildOsuSettings, upsertGuildOsuSettings } from '../database/osuGuildSettings.js';
import { metricLabel } from '../utils/osuGrowthUtils.js';
import { log } from '../utils/logger.js';

const WEEKDAY_CHOICES = [
  { name: '日曜', value: 0 },
  { name: '月曜', value: 1 },
  { name: '火曜', value: 2 },
  { name: '水曜', value: 3 },
  { name: '木曜', value: 4 },
  { name: '金曜', value: 5 },
  { name: '土曜', value: 6 }
];

const PERIOD_CHOICES = [
  { name: '24h', value: '24h' },
  { name: '1week', value: '1week' },
  { name: '1month', value: '1month' }
];

const METRIC_CHOICES = [
  { name: 'PP', value: 'pp' },
  { name: 'プレイ時間', value: 'play_time' },
  { name: 'プレイ回数', value: 'play_count' },
  { name: '順位上昇', value: 'rank_improvement' }
];

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function channelLabel(id) {
  if (!id) return '未設定';
  return `<#${id}>`;
}

function weekdayLabel(value) {
  const found = WEEKDAY_CHOICES.find(item => item.value === Number(value));
  return found ? found.name : String(value);
}

function toInt(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

export const data = new SlashCommandBuilder()
  .setName('osu-admin')
  .setDescription('osu!機能のサーバー設定を管理します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand =>
    subcommand.setName('show').setDescription('現在の設定を表示します')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-channel')
      .setDescription('通知チャンネルを設定します')
      .addStringOption(option =>
        option
          .setName('type')
          .setDescription('設定対象')
          .addChoices(
            { name: '成長アラート', value: 'alert' },
            { name: '週次レポート', value: 'report' },
            { name: 'リアルタイムスコア', value: 'realtime-score' }
          )
          .setRequired(true)
      )
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('設定するテキストチャンネル')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-threshold')
      .setDescription('アラート閾値を設定します')
      .addNumberOption(option =>
        option
          .setName('pp')
          .setDescription('PP増加で通知する閾値')
          .setMinValue(0)
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option
          .setName('rank')
          .setDescription('順位上昇で通知する閾値')
          .setMinValue(0)
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-snapshot')
      .setDescription('定期スナップショット間隔を設定します')
      .addIntegerOption(option =>
        option
          .setName('minutes')
          .setDescription('収集間隔(10〜720分)')
          .setMinValue(10)
          .setMaxValue(720)
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-report')
      .setDescription('週次レポート設定を変更します')
      .addIntegerOption(option =>
        option
          .setName('weekday')
          .setDescription('配信曜日')
          .addChoices(...WEEKDAY_CHOICES)
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option
          .setName('hour_utc')
          .setDescription('配信時刻(UTC 0〜23)')
          .setMinValue(0)
          .setMaxValue(23)
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('period')
          .setDescription('集計期間')
          .addChoices(...PERIOD_CHOICES)
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('metric')
          .setDescription('集計指標')
          .addChoices(...METRIC_CHOICES)
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option
          .setName('top')
          .setDescription('表示人数(3〜20)')
          .setMinValue(3)
          .setMaxValue(20)
          .setRequired(false)
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    if (!interaction.guildId) {
      return interaction.editReply('❌ サーバー内で実行してください');
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply('❌ このコマンドはサーバー管理者のみ実行できます');
    }

    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (subcommand === 'show') {
      const settings = await getGuildOsuSettings(guildId);
      const embed = new EmbedBuilder()
        .setColor('#6C5CE7')
        .setTitle('osu! サーバー設定')
        .addFields(
          {
            name: '通知チャンネル',
            value: `成長アラート: ${channelLabel(settings.alert_channel_id)}\n週次レポート: ${channelLabel(settings.report_channel_id)}\nリアルタイムスコア: ${channelLabel(settings.realtime_score_channel_id)}`,
            inline: false
          },
          {
            name: '閾値',
            value: `PP: +${Number(settings.alert_pp_threshold).toFixed(2)}\n順位: +${toInt(settings.alert_rank_threshold, 500)}`,
            inline: true
          },
          {
            name: 'スナップショット',
            value: `${toInt(settings.snapshot_interval_minutes, 60)} 分間隔`,
            inline: true
          },
          {
            name: '週次レポート',
            value:
              `曜日: ${weekdayLabel(settings.report_weekday)}\n` +
              `時刻(UTC): ${toInt(settings.report_hour_utc, 12)}時\n` +
              `期間: ${settings.report_period}\n` +
              `指標: ${metricLabel(settings.report_metric)}\n` +
              `TOP: ${toInt(settings.report_top, 10)}`,
            inline: false
          }
        )
        .setTimestamp(new Date());

      return interaction.editReply({ embeds: [embed] });
    }

    if (subcommand === 'set-channel') {
      const type = interaction.options.getString('type', true);
      const channel = interaction.options.getChannel('channel', true);

      if (!channel.isTextBased()) {
        return interaction.editReply('❌ テキストチャンネルを指定してください');
      }

      const patch = type === 'alert'
        ? { alert_channel_id: channel.id }
        : type === 'report'
        ? { report_channel_id: channel.id }
        : { realtime_score_channel_id: channel.id };

      await upsertGuildOsuSettings(guildId, patch);
      const typeName = type === 'alert' ? '成長アラート' : type === 'report' ? '週次レポート' : 'リアルタイムスコア';
      return interaction.editReply(`✅ ${typeName}の通知先を ${channel} に設定しました`);
    }

    if (subcommand === 'set-threshold') {
      const pp = interaction.options.getNumber('pp');
      const rank = interaction.options.getInteger('rank');

      if (pp === null && rank === null) {
        return interaction.editReply('❌ pp か rank のどちらかを指定してください');
      }

      const patch = {};
      if (pp !== null) patch.alert_pp_threshold = pp;
      if (rank !== null) patch.alert_rank_threshold = rank;

      await upsertGuildOsuSettings(guildId, patch);
      return interaction.editReply('✅ 閾値を更新しました');
    }

    if (subcommand === 'set-snapshot') {
      const minutes = interaction.options.getInteger('minutes', true);
      await upsertGuildOsuSettings(guildId, { snapshot_interval_minutes: minutes });
      return interaction.editReply(`✅ スナップショット間隔を ${minutes} 分に更新しました`);
    }

    if (subcommand === 'set-report') {
      const weekday = interaction.options.getInteger('weekday');
      const hour = interaction.options.getInteger('hour_utc');
      const period = interaction.options.getString('period');
      const metric = interaction.options.getString('metric');
      const top = interaction.options.getInteger('top');

      const patch = {};
      if (weekday !== null) patch.report_weekday = weekday;
      if (hour !== null) patch.report_hour_utc = hour;
      if (period) patch.report_period = period;
      if (metric) patch.report_metric = metric;
      if (top !== null) patch.report_top = top;

      if (Object.keys(patch).length === 0) {
        return interaction.editReply('❌ 変更する項目を1つ以上指定してください');
      }

      await upsertGuildOsuSettings(guildId, patch);
      return interaction.editReply('✅ 週次レポート設定を更新しました');
    }

    return interaction.editReply('❌ 不明なサブコマンドです');
  } catch (error) {
    log(`/osu-admin エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');
    return interaction.editReply('❌ 設定更新中にエラーが発生しました');
  }
}
