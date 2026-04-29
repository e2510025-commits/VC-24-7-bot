import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { getLatestTopPlaySnapshot, saveTopPlaySnapshot } from '../database/osuTopPlaySnapshots.js';
import {
  OsuApiError,
  fetchBestScores,
  fetchOsuUser,
  formatNumber,
  getModeLabel,
  normalizeOsuMode,
  toDiscordTimestamp
} from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('osu-topplays')
  .setDescription('Top Playsの入れ替わりを追跡します')
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
  .addIntegerOption(option =>
    option
      .setName('limit')
      .setDescription('比較対象件数 (20〜100)')
      .setMinValue(20)
      .setMaxValue(100)
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

function buildScoreTitle(score) {
  const artist = score?.beatmapset?.artist || 'Unknown Artist';
  const title = score?.beatmapset?.title || 'Unknown Title';
  const diff = score?.beatmap?.version || 'Unknown Diff';
  return `${artist} - ${title} [${diff}]`;
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
    const limit = interaction.options.getInteger('limit') || 50;

    const user = await fetchOsuUser(targetUsername, mode);
    const scores = await fetchBestScores(user.id, mode, limit);

    if (!Array.isArray(scores) || scores.length === 0) {
      return interaction.editReply(translate(lang, 'osu.topplays.fetchFailed'));
    }

    const currentIds = scores
      .map(score => Number(score?.id))
      .filter(Number.isFinite)
      .map(scoreId => Math.trunc(scoreId));

    const currentPpSum = scores.reduce((acc, score) => {
      const pp = toFiniteNumber(score?.pp);
      return acc + (pp === null ? 0 : pp);
    }, 0);

    const previous = await getLatestTopPlaySnapshot({
      osuUserId: user.id,
      mode
    });

    const previousIds = new Set(previous?.score_ids || []);
    const currentSet = new Set(currentIds);

    const added = currentIds.filter(scoreId => !previousIds.has(scoreId));
    const removed = previous?.score_ids?.filter(scoreId => !currentSet.has(scoreId)) || [];

    const previousPosition = new Map();
    for (let index = 0; index < (previous?.score_ids || []).length; index += 1) {
      previousPosition.set(previous.score_ids[index], index);
    }

    let improvedPositions = 0;
    for (let index = 0; index < currentIds.length; index += 1) {
      const scoreId = currentIds[index];
      const prevPos = previousPosition.get(scoreId);
      if (Number.isInteger(prevPos) && prevPos > index) {
        improvedPositions += 1;
      }
    }

    await saveTopPlaySnapshot({
      discordId: interaction.user.id,
      osuUserId: user.id,
      osuUsername: user.username,
      mode,
      topLimit: limit,
      scoreIds: currentIds,
      topPpSum: currentPpSum
    });

    const addedLines = scores
      .filter(score => added.includes(Math.trunc(Number(score?.id))))
      .slice(0, 5)
      .map(score => {
        const pp = toFiniteNumber(score?.pp);
        const scoreId = Number(score?.id);
        const url = Number.isFinite(scoreId)
          ? `https://osu.ppy.sh/scores/${score.mode || mode}/${Math.trunc(scoreId)}`
          : `https://osu.ppy.sh/users/${user.id}`;
        return `[${buildScoreTitle(score)}](${url}) ${pp === null ? 'N/A' : `${pp.toFixed(2)}pp`}`;
      });

    const embed = new EmbedBuilder()
      .setColor('#00CEC9')
      .setTitle(`${user.username} Top Plays 変化追跡 [${getModeLabel(mode)}]`)
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(`比較範囲: Top ${limit}`)
      .addFields(
        {
          name: 'サマリー',
          value: [
            `新規ランクイン: ${formatNumber(added.length)}`,
            `圏外に移動: ${formatNumber(removed.length)}`,
            `順位上昇譜面数: ${formatNumber(improvedPositions)}`,
            `TopPP合計: ${currentPpSum.toFixed(2)}pp`
          ].join('\n'),
          inline: true
        },
        {
          name: '前回比較',
          value: previous
            ? `前回取得: ${toDiscordTimestamp(previous.captured_at)}\n前回TopPP合計: ${toFiniteNumber(previous.top_pp_sum) === null ? 'N/A' : `${Number(previous.top_pp_sum).toFixed(2)}pp`}`
            : '初回実行のため、今回の結果をベースラインとして保存しました',
          inline: true
        }
      )
      .setTimestamp(new Date());

    if (addedLines.length > 0) {
      embed.addFields({
        name: '新規ランクイン詳細',
        value: addedLines.join('\n'),
        inline: false
      });
    }

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-topplays エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.topplays.failed'));
  }
}
