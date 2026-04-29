import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { listBestScoreEventsSince } from '../database/osuBestScoreEvents.js';
import {
  OsuApiError,
  fetchOsuUser,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const SPAN_CHOICES = [
  { name: '30日', value: '30d' },
  { name: '90日', value: '90d' }
];

const TIME_BUCKETS = [
  { label: '00-05', from: 0, to: 5 },
  { label: '06-11', from: 6, to: 11 },
  { label: '12-17', from: 12, to: 17 },
  { label: '18-23', from: 18, to: 23 }
];

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HEAT_LEVELS = ['.', ':', '*', '#', '@'];

export const data = new SlashCommandBuilder()
  .setName('osu-heatmap')
  .setDescription('ベスト更新の時間帯ヒートマップを表示します')
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
      .setName('span')
      .setDescription('集計期間')
      .addChoices(...SPAN_CHOICES)
      .setRequired(false)
  );

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

function bucketIndexForHour(hour) {
  for (let index = 0; index < TIME_BUCKETS.length; index += 1) {
    const bucket = TIME_BUCKETS[index];
    if (hour >= bucket.from && hour <= bucket.to) {
      return index;
    }
  }
  return 0;
}

function toHeatChar(value, max) {
  if (value <= 0 || max <= 0) {
    return HEAT_LEVELS[0];
  }

  const ratio = value / max;
  if (ratio >= 0.8) return HEAT_LEVELS[4];
  if (ratio >= 0.6) return HEAT_LEVELS[3];
  if (ratio >= 0.4) return HEAT_LEVELS[2];
  if (ratio >= 0.2) return HEAT_LEVELS[1];
  return HEAT_LEVELS[0];
}

function buildHeatmapText(matrix) {
  const max = Math.max(...matrix.flat(), 0);
  const lines = [];
  lines.push(`      ${TIME_BUCKETS.map(bucket => bucket.label).join('  ')}`);

  for (let day = 0; day < WEEKDAY_LABELS.length; day += 1) {
    const chars = matrix[day].map(value => toHeatChar(value, max));
    lines.push(`${WEEKDAY_LABELS[day].padEnd(4, ' ')} | ${chars.join('     ')}`);
  }

  lines.push('Legend: . low -> @ high');
  return ['```', ...lines, '```'].join('\n');
}

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const targetUsername = await resolveTargetUsername(interaction);
    if (!targetUsername) {
      return interaction.editReply(
        translate(lang, 'osu.requireLink')
      );
    }

    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const span = interaction.options.getString('span') || '90d';
    const lookbackDays = span === '30d' ? 30 : 90;

    const user = await fetchOsuUser(targetUsername, mode);
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const events = await listBestScoreEventsSince({
      osuUserId: user.id,
      mode,
      sinceDate: since,
      limit: 2000
    });

    if (events.length === 0) {
      return interaction.editReply(
        translate(lang, 'osu.heatmap.noEvents', { days: lookbackDays })
      );
    }

    const matrix = Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => 0));

    for (const event of events) {
      const date = new Date(event.recorded_at);
      if (!Number.isFinite(date.getTime())) {
        continue;
      }
      const day = date.getUTCDay();
      const bucket = bucketIndexForHour(date.getUTCHours());
      matrix[day][bucket] += 1;
    }

    let peak = { day: 0, bucket: 0, value: 0 };
    for (let day = 0; day < matrix.length; day += 1) {
      for (let bucket = 0; bucket < matrix[day].length; bucket += 1) {
        if (matrix[day][bucket] > peak.value) {
          peak = { day, bucket, value: matrix[day][bucket] };
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor('#E67E22')
      .setTitle(`${user.username} ベスト更新ヒートマップ [${getModeLabel(mode)}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(`対象期間: 直近${lookbackDays}日 / 更新数: ${events.length}`)
      .addFields(
        {
          name: 'Heatmap (UTC)',
          value: buildHeatmapText(matrix),
          inline: false
        },
        {
          name: '最頻更新帯',
          value:
            peak.value <= 0
              ? 'N/A'
              : `${WEEKDAY_LABELS[peak.day]} ${TIME_BUCKETS[peak.bucket].label} (${peak.value}回)`,
          inline: true
        },
        {
          name: '最新更新',
          value: toDiscordTimestamp(events[events.length - 1]?.recorded_at),
          inline: true
        }
      )
      .setTimestamp(new Date());

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-heatmap エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.heatmap.failed'));
  }
}
