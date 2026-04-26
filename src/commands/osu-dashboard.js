import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getClosestSnapshotBefore, saveOsuSnapshot } from '../database/osuSnapshots.js';
import {
  OsuApiError,
  fetchOsuUser,
  formatNumber,
  getModeLabel,
  normalizeOsuMode
} from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

const MODES = ['osu', 'taiko', 'fruits', 'mania'];

export const data = new SlashCommandBuilder()
  .setName('osu-dashboard')
  .setDescription('4モードをまとめて確認できるダッシュボードを表示します')
  .addStringOption(option =>
    option
      .setName('username')
      .setDescription('表示するosu!ユーザー名（省略時は連携済みユーザー）')
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

function formatRank(rank) {
  const value = toFiniteNumber(rank);
  if (value === null || value <= 0) {
    return 'N/A';
  }
  return `#${formatNumber(Math.trunc(value))}`;
}

function formatPpDelta(delta) {
  const value = toFiniteNumber(delta);
  if (value === null) {
    return 'N/A';
  }

  if (value === 0) {
    return '±0.00pp';
  }

  return `${value > 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}pp`;
}

function formatRankDelta(previousRank, currentRank) {
  const prev = toFiniteNumber(previousRank);
  const curr = toFiniteNumber(currentRank);
  if (prev === null || curr === null || prev <= 0 || curr <= 0) {
    return 'N/A';
  }

  const delta = Math.trunc(prev - curr);
  if (delta === 0) {
    return '±0';
  }

  return delta > 0 ? `↑${formatNumber(delta)}` : `↓${formatNumber(Math.abs(delta))}`;
}

export async function execute(interaction) {
  await interaction.deferReply();

  try {
    const targetUsername = await resolveTargetUsername(interaction);
    if (!targetUsername) {
      return interaction.editReply(
        '❌ ユーザー名を指定するか、先に /osu-link username:<osu名> で連携してください'
      );
    }

    const baseUser = await fetchOsuUser(targetUsername, null);
    const now = Date.now();

    const embed = new EmbedBuilder()
      .setColor('#1ABC9C')
      .setTitle(`${baseUser.username} のモード別ダッシュボード`)
      .setURL(`https://osu.ppy.sh/users/${baseUser.id}`)
      .setDescription('4モードの現在値と24h変化をまとめて表示')
      .setTimestamp(new Date());

    for (const mode of MODES) {
      try {
        const modeUser = await fetchOsuUser(baseUser.id, normalizeOsuMode(mode));
        const stats = modeUser.statistics || {};

        await saveOsuSnapshot({
          discordId: interaction.user.id,
          osuUserId: modeUser.id,
          osuUsername: modeUser.username,
          mode,
          pp: stats.pp,
          globalRank: stats.global_rank,
          countryRank: stats.country_rank,
          playTimeSeconds: stats.play_time,
          playCount: stats.play_count
        });

        const snapshot = await getClosestSnapshotBefore({
          osuUserId: modeUser.id,
          mode,
          beforeDate: new Date(now - 24 * 60 * 60 * 1000)
        });

        const ppDelta =
          snapshot && toFiniteNumber(snapshot.pp) !== null && toFiniteNumber(stats.pp) !== null
            ? toFiniteNumber(stats.pp) - toFiniteNumber(snapshot.pp)
            : null;

        embed.addFields({
          name: `[${getModeLabel(mode)}]`,
          value: [
            `PP: ${formatNumber(stats.pp)}pp`,
            `順位: ${formatRank(stats.global_rank)}`,
            `24h PP: ${formatPpDelta(ppDelta)}`,
            `24h 順位: ${formatRankDelta(snapshot?.global_rank, stats.global_rank)}`
          ].join('\n'),
          inline: true
        });
      } catch {
        embed.addFields({
          name: `[${getModeLabel(mode)}]`,
          value: 'データ取得不可',
          inline: true
        });
      }
    }

    if (baseUser.avatar_url) {
      embed.setThumbnail(baseUser.avatar_url);
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-dashboard エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply('❌ ダッシュボード取得中にエラーが発生しました');
  }
}
