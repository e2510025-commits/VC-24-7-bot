import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getGuildOsuSettings, upsertGuildOsuSettings } from '../database/osuGuildSettings.js';
import { metricLabel } from '../utils/osuGrowthUtils.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
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

function channelLabel(id, lang) {
  if (!id) return translate(lang, 'common.unset');
  return `<#${id}>`;
}

function roleLabel(id, lang) {
  if (!id) return translate(lang, 'common.unset');
  return `<@&${id}>`;
}

function weekdayLabel(value, lang) {
  const found = WEEKDAY_CHOICES.find(item => item.value === Number(value));
  return found ? translate(lang, `osuAdmin.weekday.${found.value}`) : String(value);
}

function toInt(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

const data = new SlashCommandBuilder()
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
            { name: 'リアルタイムスコア', value: 'realtime-score' },
            { name: '日次プレイ履歴', value: 'daily-history' }
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
  
data.addSubcommand(subcommand =>
  subcommand
    .setName('set-role')
    .setDescription('重要更新時にメンションするロールを設定します')
    .addRoleOption(option =>
      option
        .setName('role')
        .setDescription('設定するロール（省略で解除）')
        .setRequired(false)
    )
);

export { data };

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guildId) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply(translate(lang, 'common.adminOnly'));
    }

    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (subcommand === 'show') {
      const settings = await getGuildOsuSettings(guildId);
      const embed = new EmbedBuilder()
        .setColor('#6C5CE7')
        .setTitle(translate(lang, 'osuAdmin.title'))
        .addFields(
          {
            name: translate(lang, 'osuAdmin.channelsTitle'),
            value: [
              `${translate(lang, 'osuAdmin.channel.alert')}: ${channelLabel(settings.alert_channel_id, lang)}`,
              `${translate(lang, 'osuAdmin.channel.report')}: ${channelLabel(settings.report_channel_id, lang)}`,
              `${translate(lang, 'osuAdmin.channel.realtime')}: ${channelLabel(settings.realtime_score_channel_id, lang)}`,
              `${translate(lang, 'osuAdmin.channel.daily')}: ${channelLabel(settings.daily_history_channel_id, lang)}`
            ].join('\n'),
            inline: false
          },
          {
            name: translate(lang, 'osuAdmin.roleTitle'),
            value: roleLabel(settings.important_update_role_id, lang),
            inline: false
          },
          {
            name: translate(lang, 'osuAdmin.thresholdTitle'),
            value: [
              `${translate(lang, 'osuAdmin.pp')}: +${Number(settings.alert_pp_threshold).toFixed(2)}`,
              `${translate(lang, 'osuAdmin.rank')}: +${toInt(settings.alert_rank_threshold, 500)}`
            ].join('\n'),
            inline: true
          },
          {
            name: translate(lang, 'osuAdmin.snapshotTitle'),
            value: translate(lang, 'osuAdmin.snapshotInterval', {
              minutes: toInt(settings.snapshot_interval_minutes, 60)
            }),
            inline: true
          },
          {
            name: translate(lang, 'osuAdmin.reportTitle'),
            value:
              `${translate(lang, 'osuAdmin.reportWeekday')}: ${weekdayLabel(settings.report_weekday, lang)}\n` +
              `${translate(lang, 'osuAdmin.reportHour')}: ${toInt(settings.report_hour_utc, 12)}\n` +
              `${translate(lang, 'osuAdmin.reportPeriod')}: ${settings.report_period}\n` +
              `${translate(lang, 'osuAdmin.reportMetric')}: ${metricLabel(settings.report_metric, lang)}\n` +
              `${translate(lang, 'osuAdmin.reportTop')}: ${toInt(settings.report_top, 10)}`,
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
        return interaction.editReply(translate(lang, 'osuAdmin.channelNotText'));
      }

      let patch;
      let typeName;
      
      if (type === 'alert') {
        patch = { alert_channel_id: channel.id };
        typeName = translate(lang, 'osuAdmin.channel.alert');
      } else if (type === 'report') {
        patch = { report_channel_id: channel.id };
        typeName = translate(lang, 'osuAdmin.channel.report');
      } else if (type === 'realtime-score') {
        patch = { realtime_score_channel_id: channel.id };
        typeName = translate(lang, 'osuAdmin.channel.realtime');
      } else if (type === 'daily-history') {
        patch = { daily_history_channel_id: channel.id };
        typeName = translate(lang, 'osuAdmin.channel.daily');
      } else {
        return interaction.editReply(translate(lang, 'osuAdmin.channelTypeUnknown'));
      }

      await upsertGuildOsuSettings(guildId, patch);
      return interaction.editReply(
        translate(lang, 'osuAdmin.channelSet', {
          typeName,
          channel: `${channel}`
        })
      );
    }

    if (subcommand === 'set-threshold') {
      const pp = interaction.options.getNumber('pp');
      const rank = interaction.options.getInteger('rank');

      if (pp === null && rank === null) {
        return interaction.editReply(translate(lang, 'osuAdmin.thresholdNeed'));
      }

      const patch = {};
      if (pp !== null) patch.alert_pp_threshold = pp;
      if (rank !== null) patch.alert_rank_threshold = rank;

      await upsertGuildOsuSettings(guildId, patch);
      return interaction.editReply(translate(lang, 'osuAdmin.thresholdUpdated'));
    }

    if (subcommand === 'set-snapshot') {
      const minutes = interaction.options.getInteger('minutes', true);
      await upsertGuildOsuSettings(guildId, { snapshot_interval_minutes: minutes });
      return interaction.editReply(
        translate(lang, 'osuAdmin.snapshotUpdated', { minutes })
      );
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
        return interaction.editReply(translate(lang, 'osuAdmin.noChange'));
      }

      await upsertGuildOsuSettings(guildId, patch);
      return interaction.editReply(translate(lang, 'osuAdmin.reportUpdated'));
    }

    if (subcommand === 'set-role') {
      const role = interaction.options.getRole('role');
      await upsertGuildOsuSettings(guildId, {
        important_update_role_id: role?.id || null
      });

      if (role) {
        return interaction.editReply(
          translate(lang, 'osuAdmin.roleSet', { role: `${role}` })
        );
      }

      return interaction.editReply(translate(lang, 'osuAdmin.roleCleared'));
    }

    return interaction.editReply(translate(lang, 'common.unknownSubcommand'));
  } catch (error) {
    log(`/osu-admin エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');
    return interaction.editReply(
      translate(lang, 'osuAdmin.failed', { error: error.message })
    );
  }
}
