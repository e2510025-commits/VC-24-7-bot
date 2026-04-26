import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getClosestSnapshotBefore, saveOsuSnapshot } from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchOsuUser,
  formatNumber,
  formatPlayTime,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

const WINDOWS = [
  { key: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { key: '1week', label: '1week', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '1month', label: '1month', ms: 30 * 24 * 60 * 60 * 1000 }
];

export const data = new SlashCommandBuilder()
  .setName('osu-growth')
  .setDescription('osu!の24h/1week/1month成長率を表示します')
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
  );

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatSignedDecimal(value, digits = 2) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  if (numeric === 0) {
    return `±${numeric.toFixed(digits)}`;
  }

  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${Math.abs(numeric).toFixed(digits)}`;
}

function formatSignedInteger(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return 'N/A';
  }

  const absValue = Math.trunc(Math.abs(numeric));
  if (absValue === 0) {
    return '±0';
  }

  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${formatNumber(absValue)}`;
}

function formatPercentDelta(delta, baseline) {
  const deltaValue = toFiniteNumber(delta);
  const baselineValue = toFiniteNumber(baseline);

  if (deltaValue === null || baselineValue === null || baselineValue === 0) {
    return '前比 N/A';
  }

  const ratio = (deltaValue / baselineValue) * 100;
  const sign = ratio > 0 ? '+' : ratio < 0 ? '-' : '±';
  return `前比 ${sign}${Math.abs(ratio).toFixed(2)}%`;
}

function formatRank(rank) {
  const numeric = toFiniteNumber(rank);
  if (numeric === null || numeric <= 0) {
    return 'N/A';
  }
  return `#${formatNumber(Math.trunc(numeric))}`;
}

function formatRankDelta(previousRank, currentRank) {
  const prev = toFiniteNumber(previousRank);
  const curr = toFiniteNumber(currentRank);

  if (prev === null || curr === null || prev <= 0 || curr <= 0) {
    return `${formatRank(prev)} -> ${formatRank(curr)} (N/A)`;
  }

  const rankChange = Math.trunc(prev - curr);
  const marker = rankChange > 0 ? `↑${formatNumber(rankChange)}` : rankChange < 0 ? `↓${formatNumber(Math.abs(rankChange))}` : '±0';

  return `${formatRank(prev)} -> ${formatRank(curr)} (${marker})`;
}

function formatDurationDelta(seconds) {
  const numeric = toFiniteNumber(seconds);
  if (numeric === null) {
    return 'N/A';
  }

  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '±';
  const totalSeconds = Math.max(0, Math.trunc(Math.abs(numeric)));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  parts.push(`${minutes}分`);

  return `${sign}${parts.join(' ')}`;
}

function buildWindowFieldValue(currentStats, snapshot) {
  if (!snapshot) {
    return 'データ不足（この期間のスナップショットがありません）';
  }

  const currentPp = toFiniteNumber(currentStats.pp);
  const prevPp = toFiniteNumber(snapshot.pp);
  const ppDelta = currentPp !== null && prevPp !== null ? currentPp - prevPp : null;

  const currentPlayTime = toFiniteNumber(currentStats.play_time);
  const prevPlayTime = toFiniteNumber(snapshot.play_time_seconds);
  const playTimeDelta =
    currentPlayTime !== null && prevPlayTime !== null ? currentPlayTime - prevPlayTime : null;

  const currentPlayCount = toFiniteNumber(currentStats.play_count);
  const prevPlayCount = toFiniteNumber(snapshot.play_count);
  const playCountDelta =
    currentPlayCount !== null && prevPlayCount !== null ? currentPlayCount - prevPlayCount : null;

  return [
    `PP: ${formatSignedDecimal(ppDelta)}pp (${formatPercentDelta(ppDelta, prevPp)})`,
    `プレイ時間: ${formatDurationDelta(playTimeDelta)} (${formatPercentDelta(playTimeDelta, prevPlayTime)})`,
    `プレイ回数: ${formatSignedInteger(playCountDelta)} (${formatPercentDelta(playCountDelta, prevPlayCount)})`,
    `順位: ${formatRankDelta(snapshot.global_rank, currentStats.global_rank)}`,
    `比較基準: ${toDiscordTimestamp(snapshot.captured_at)}`
  ].join('\n');
}

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const requestedMode = interaction.options.getString('mode') || 'osu';
    const mode = normalizeOsuMode(requestedMode);
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);

    if (!targetUsername) {
      return interaction.editReply(
        '❌ ユーザー名を指定するか、先に `/osu-link username:<osu名>` で連携してください'
      );
    }

    const user = await fetchOsuUser(targetUsername, mode);
    const stats = user.statistics || {};

    const userId = toFiniteNumber(user.id);
    if (userId === null) {
      throw new Error('osu!ユーザーIDの取得に失敗しました');
    }

    const now = Date.now();
    const windowSnapshots = await Promise.all(
      WINDOWS.map(window =>
        getClosestSnapshotBefore({
          osuUserId: userId,
          mode,
          beforeDate: new Date(now - window.ms)
        })
      )
    );

    await saveOsuSnapshot({
      osuUserId: userId,
      mode,
      pp: stats.pp,
      globalRank: stats.global_rank,
      countryRank: stats.country_rank,
      playTimeSeconds: stats.play_time,
      playCount: stats.play_count
    });

    const currentRank = formatRank(stats.global_rank);
    const currentCountryRank = formatRank(stats.country_rank);

    const embed = new EmbedBuilder()
      .setColor('#FF66AA')
      .setTitle(`${user.username} の成長率 [${modeLabel}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription('24h / 1week / 1month の前比を表示します（実行時に履歴を自動保存）')
      .addFields(
        {
          name: '現在値',
          value: [
            `PP: ${formatNumber(stats.pp)}pp`,
            `順位: ${currentRank}`,
            `国別順位 (${user.country_code || 'N/A'}): ${currentCountryRank}`,
            `プレイ時間: ${formatPlayTime(stats.play_time)}`,
            `プレイ回数: ${formatNumber(stats.play_count)}`
          ].join('\n')
        },
        {
          name: '24h',
          value: buildWindowFieldValue(stats, windowSnapshots[0]),
          inline: false
        },
        {
          name: '1week',
          value: buildWindowFieldValue(stats, windowSnapshots[1]),
          inline: false
        },
        {
          name: '1month',
          value: buildWindowFieldValue(stats, windowSnapshots[2]),
          inline: false
        }
      )
      .setFooter({ text: '初回実行直後は履歴不足になる場合があります。時間をおいて再実行してください。' })
      .setTimestamp(new Date());

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-growth エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ 成長率データ取得中にエラーが発生しました');
  }
}
