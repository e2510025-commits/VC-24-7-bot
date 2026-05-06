import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import {
  OsuApiError,
  fetchOsuUser,
  fetchRecentScores,
  formatNumber,
  formatRatioPercent,
  getModeLabel,
  normalizeOsuMode
} from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function calcMissCount(score) {
  const miss = score?.statistics?.count_miss ?? score?.statistics?.miss;
  const numeric = toNumber(miss);
  return numeric === null ? 0 : numeric;
}

function calcTotalHits(score) {
  const stats = score?.statistics || {};
  const fields = [
    'count_300',
    'count_100',
    'count_50',
    'count_miss',
    'great',
    'perfect',
    'ok',
    'meh',
    'miss',
    'large_tick_hit',
    'small_tick_hit'
  ];
  return fields.reduce((acc, key) => {
    const numeric = toNumber(stats[key]);
    return acc + (numeric === null ? 0 : numeric);
  }, 0);
}

function formatSignedPercent(delta) {
  const numeric = toNumber(delta);
  if (numeric === null) {
    return 'N/A';
  }

  if (numeric === 0) {
    return '±0.00%';
  }

  const sign = numeric > 0 ? '+' : '-';
  return `${sign}${Math.abs(numeric).toFixed(2)}%`;
}

function formatSeconds(seconds, lang) {
  const value = toNumber(seconds);
  if (value === null) {
    return 'N/A';
  }
  return translate(lang, 'osuAnalysis.secondsFormat', { seconds: Math.round(value) });
}

function averageFromScores(scores, selector) {
  if (!Array.isArray(scores) || scores.length === 0) {
    return null;
  }

  const values = scores
    .map(selector)
    .map(value => toNumber(value))
    .filter(value => value !== null);

  return average(values);
}

function starBucket(star, lang) {
  const value = toNumber(star);
  if (value === null) return null;
  if (value < 3) return translate(lang, 'osuAnalysis.starBucketLow');
  if (value < 5) return translate(lang, 'osuAnalysis.starBucketMid');
  return translate(lang, 'osuAnalysis.starBucketHigh');
}

function lengthBucket(seconds, lang) {
  const value = toNumber(seconds);
  if (value === null) return null;
  if (value < 90) return translate(lang, 'osuAnalysis.lengthBucketShort');
  if (value < 210) return translate(lang, 'osuAnalysis.lengthBucketMid');
  return translate(lang, 'osuAnalysis.lengthBucketLong');
}

function topBucketLabel(scores, bucketSelector, lang) {
  const counts = new Map();

  for (const score of scores) {
    const label = bucketSelector(score);
    if (!label) {
      continue;
    }
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return 'N/A';
  }

  return translate(lang, 'osuAnalysis.topBucketFormat', {
    label: sorted[0][0],
    count: sorted[0][1]
  });
}

function topMods(scores, lang) {
  const counts = new Map();

  for (const score of scores) {
    const mods = Array.isArray(score?.mods) && score.mods.length > 0
      ? score.mods.join('')
      : 'NM';
    counts.set(mods, (counts.get(mods) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return 'N/A';
  }

  return translate(lang, 'osuAnalysis.topModsFormat', {
    mods: sorted[0][0],
    count: sorted[0][1]
  });
}

async function resolveTargetUsername(interaction) {
  const input = interaction.options.getString('username');
  if (input?.trim()) {
    return input.trim();
  }

  return getLinkedOsuUsername(interaction.user.id);
}

export const data = new SlashCommandBuilder()
  .setName('osu-analysis')
  .setDescription('最近のプレイ品質を分析します')
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
      .setDescription('分析対象のプレイ数 (5〜50)')
      .setMinValue(5)
      .setMaxValue(50)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    const mode = normalizeOsuMode(interaction.options.getString('mode') || 'osu');
    const limit = interaction.options.getInteger('limit') || 20;
    const modeLabel = getModeLabel(mode);
    const targetUsername = await resolveTargetUsername(interaction);

    if (!targetUsername) {
      return interaction.editReply(
        translate(lang, 'osu.requireLink')
      );
    }

    const user = await fetchOsuUser(targetUsername, mode);
    const scores = await fetchRecentScores(user.id, mode, limit);

    if (!Array.isArray(scores) || scores.length === 0) {
      return interaction.editReply(translate(lang, 'osu.analysis.noScores'));
    }

    const successful = scores.filter(score => score?.passed);
    const failed = scores.filter(score => !score?.passed);

    const accuracyList = successful
      .map(score => toNumber(score?.accuracy))
      .filter(value => value !== null);

    const ppList = successful
      .map(score => toNumber(score?.pp))
      .filter(value => value !== null);

    const missPerMap = successful.map(score => calcMissCount(score));

    const hitErrorRates = successful
      .map(score => {
        const miss = calcMissCount(score);
        const totalHits = calcTotalHits(score);
        if (totalHits <= 0) {
          return null;
        }
        return miss / totalHits;
      })
      .filter(value => value !== null);

    const avgAccRatio = average(accuracyList);
    const avgPp = average(ppList);
    const avgMiss = average(missPerMap);
    const avgMissRate = average(hitErrorRates);

    const split = Math.floor(successful.length / 2);
    const firstHalf = successful.slice(0, split);
    const secondHalf = successful.slice(split);

    const firstHalfAcc = average(
      firstHalf.map(score => toNumber(score?.accuracy)).filter(value => value !== null)
    );
    const secondHalfAcc = average(
      secondHalf.map(score => toNumber(score?.accuracy)).filter(value => value !== null)
    );

    const trendAccDelta =
      firstHalfAcc !== null && secondHalfAcc !== null
        ? (secondHalfAcc - firstHalfAcc) * 100
        : null;

    const passRate = scores.length > 0 ? successful.length / scores.length : null;

    const avgStar = averageFromScores(successful, score => score?.beatmap?.difficulty_rating);
    const avgLength = averageFromScores(successful, score => score?.beatmap?.total_length);
    const avgBpm = averageFromScores(successful, score => score?.beatmap?.bpm);
    const topStarRange = topBucketLabel(
      successful,
      score => starBucket(score?.beatmap?.difficulty_rating, lang),
      lang
    );
    const topLengthRange = topBucketLabel(
      successful,
      score => lengthBucket(score?.beatmap?.total_length, lang),
      lang
    );
    const topModsLabel = topMods(successful, lang);

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle(translate(lang, 'osuAnalysis.title', { username: user.username, mode: modeLabel }))
      .setURL(`https://osu.ppy.sh/users/${user.id}`)
      .setDescription(translate(lang, 'osuAnalysis.description', { count: scores.length }))
      .addFields(
        {
          name: translate(lang, 'osuAnalysis.successRate'),
          value: passRate === null ? 'N/A' : formatRatioPercent(passRate),
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.avgAccuracy'),
          value: avgAccRatio === null ? 'N/A' : formatRatioPercent(avgAccRatio),
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.avgPp'),
          value: avgPp === null ? 'N/A' : `${avgPp.toFixed(2)}pp`,
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.avgMiss'),
          value: avgMiss === null ? 'N/A' : `${avgMiss.toFixed(2)}`,
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.missRate'),
          value: avgMissRate === null ? 'N/A' : formatRatioPercent(avgMissRate),
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.lateTrend'),
          value: formatSignedPercent(trendAccDelta),
          inline: true
        },
        {
          name: translate(lang, 'osuAnalysis.note'),
          value: translate(lang, 'osuAnalysis.noteFormat', {
            success: successful.length,
            failed: failed.length,
            limit
          }),
          inline: false
        },
        {
          name: translate(lang, 'osuAnalysis.mapTrends'),
          value: [
            translate(lang, 'osuAnalysis.mapTrendLine', {
              star: avgStar === null ? 'N/A' : `${avgStar.toFixed(2)}★`,
              length: formatSeconds(avgLength, lang),
              bpm: avgBpm === null ? 'N/A' : `${Math.round(avgBpm)} BPM`
            }),
            `${translate(lang, 'osuAnalysis.topStarLabel')}: ${topStarRange}`,
            `${translate(lang, 'osuAnalysis.topLengthLabel')}: ${topLengthRange}`,
            `${translate(lang, 'osuAnalysis.topModsLabel')}: ${topModsLabel}`
          ].join('\n'),
          inline: false
        }
      )
      .setTimestamp(new Date());

    if (user.avatar_url) {
      embed.setThumbnail(user.avatar_url);
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    log(`/osu-analysis エラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');

    if (error instanceof OsuApiError) {
      return interaction.editReply(`❌ ${error.message}`);
    }

    return interaction.editReply(translate(lang, 'osu.analysis.failed'));
  }
}
