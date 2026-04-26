import { EmbedBuilder } from 'discord.js';
import { listTrackedOsuUsers } from '../database/osuTrackedUsers.js';
import { getGuildOsuSettings } from '../database/osuGuildSettings.js';
import { fetchRecentScores, getModeLabel, formatNumber, normalizeOsuMode } from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

let monitorTimer = null;
let isRunning = false;
const processedScores = new Set();
const SCORE_CACHE_SIZE = 1000;

function parseModes() {
  const raw = process.env.OSU_REALTIME_MODES || process.env.OSU_SNAPSHOT_MODES || 'osu';
  const modes = raw
    .split(',')
    .map(mode => normalizeOsuMode(mode))
    .filter(Boolean);

  return modes.length > 0 ? [...new Set(modes)] : ['osu'];
}

function parseIntervalSeconds() {
  const numeric = Number(process.env.OSU_REALTIME_INTERVAL_SECONDS || 60);
  if (!Number.isFinite(numeric) || numeric < 30) {
    return 60;
  }
  return Math.trunc(numeric);
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatAccuracyPercent(accuracyRatio) {
  const value = toFiniteNumber(accuracyRatio);
  if (value === null) {
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
}

function formatCombo(comboValue) {
  const value = toFiniteNumber(comboValue);
  if (value === null) {
    return 'N/A';
  }
  return `${formatNumber(Math.trunc(value))}x`;
}

function getRankEmoji(rank) {
  const rankMap = {
    'XH': '🥇',
    'X': '🥇',
    'SH': '🥈',
    'S': '🥈',
    'A': '🥉',
    'B': '📘',
    'C': '📗',
    'D': '📙'
  };
  return rankMap[rank] || '📄';
}

function buildScoreEmbed({ user, mode, score }) {
  const beatmap = score?.beatmap || {};
  const beatmapset = score?.beatmapset || {};
  const statistics = score?.statistics || {};
  
  const mods = Array.isArray(score?.mods) && score.mods.length > 0
    ? score.mods.join(', ')
    : 'NM';
  
  const title = `${beatmapset.artist || 'Unknown Artist'} - ${beatmapset.title || 'Unknown Title'} [${beatmap.version || 'Unknown Diff'}]`;
  const scoreUrl = score?.id
    ? `https://osu.ppy.sh/scores/${score.mode || mode}/${score.id}`
    : `https://osu.ppy.sh/users/${user.id}`;
  
  const pp = toFiniteNumber(score?.pp);
  const accuracy = toFiniteNumber(score?.accuracy);
  const maxCombo = toFiniteNumber(score?.max_combo);
  const miss = toFiniteNumber(statistics?.miss);
  const rank = score?.rank || 'F';
  
  const embed = new EmbedBuilder()
    .setColor('#FF66AA')
    .setTitle(`${getRankEmoji(rank)} ${user.username} [${getModeLabel(mode)}]`)
    .setURL(scoreUrl)
    .setDescription(`**${title}**`)
    .addFields(
      {
        name: 'PP',
        value: pp === null ? 'N/A' : `${pp.toFixed(2)}pp`,
        inline: true
      },
      {
        name: '精度',
        value: formatAccuracyPercent(accuracy),
        inline: true
      },
      {
        name: 'ランク',
        value: rank,
        inline: true
      },
      {
        name: 'コンボ',
        value: formatCombo(maxCombo),
        inline: true
      },
      {
        name: 'Miss',
        value: miss === null ? 'N/A' : formatNumber(Math.trunc(miss)),
        inline: true
      },
      {
        name: 'MOD',
        value: mods,
        inline: true
      }
    )
    .setTimestamp(new Date(score?.created_at || Date.now()));
  
  if (beatmapset?.covers?.card) {
    embed.setThumbnail(beatmapset.covers.card);
  }
  
  return embed;
}

async function sendScoreToGuildChannels(client, guildSettingsMap, discordId, embed) {
  if (!embed) {
    return 0;
  }

  let sent = 0;

  for (const [guildId, settings] of guildSettingsMap.entries()) {
    // リアルタイムスコア投稿用のチャンネルを確認
    const channelId = settings.realtime_score_channel_id || settings.alert_channel_id;
    if (!channelId) {
      continue;
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      continue;
    }

    // ユーザーがギルドのメンバーか確認
    let isMember = guild.members.cache.has(discordId);
    if (!isMember) {
      try {
        await guild.members.fetch({ user: discordId, force: false });
        isMember = true;
      } catch {
        isMember = false;
      }
    }

    if (!isMember) {
      continue;
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      continue;
    }

    await channel.send({ embeds: [embed] }).catch(() => null);
    sent += 1;
  }

  return sent;
}

async function monitorCycle(client) {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    const trackedUsers = await listTrackedOsuUsers();
    if (trackedUsers.length === 0) {
      return;
    }

    const modes = parseModes();
    const guildSettingsMap = new Map();
    
    for (const [guildId] of client.guilds.cache) {
      const settings = await getGuildOsuSettings(guildId);
      guildSettingsMap.set(guildId, settings);
    }

    let scoreCount = 0;

    for (const trackedUser of trackedUsers) {
      const discordId = String(trackedUser.discord_id || '').trim();
      const osuUserId = toFiniteNumber(trackedUser.osu_user_id);

      if (!discordId || osuUserId === null) {
        continue;
      }

      for (const mode of modes) {
        try {
          // 最新5件のスコアを取得
          const recentScores = await fetchRecentScores(osuUserId, mode, 5);
          
          for (const score of recentScores) {
            const scoreKey = `${osuUserId}:${mode}:${score.id}`;
            
            // 既に処理済みのスコアはスキップ
            if (processedScores.has(scoreKey)) {
              continue;
            }

            // スコアが1時間以内のものだけ処理
            const scoreTime = new Date(score.created_at).getTime();
            const now = Date.now();
            if (now - scoreTime > 60 * 60 * 1000) {
              processedScores.add(scoreKey);
              continue;
            }

            const embed = buildScoreEmbed({
              user: {
                id: osuUserId,
                username: trackedUser.osu_username
              },
              mode,
              score
            });

            const sent = await sendScoreToGuildChannels(
              client,
              guildSettingsMap,
              discordId,
              embed
            );

            if (sent > 0) {
              scoreCount += 1;
            }

            processedScores.add(scoreKey);
          }
        } catch (error) {
          log(`osu! リアルタイムスコア取得失敗: ${trackedUser.osu_username} [${mode}] - ${error.message}`, 'error');
        }
      }
    }

    // キャッシュサイズ制限
    if (processedScores.size > SCORE_CACHE_SIZE) {
      const entries = Array.from(processedScores);
      const toRemove = entries.slice(0, entries.length - SCORE_CACHE_SIZE);
      toRemove.forEach(key => processedScores.delete(key));
    }

    if (scoreCount > 0) {
      log(`osu! リアルタイムスコア投稿: ${scoreCount}件`, 'success');
    }
  } catch (error) {
    log(`osu! リアルタイムスコア監視エラー: ${error.message}`, 'error');
  } finally {
    isRunning = false;
  }
}

export function startOsuRealtimeScoreMonitor(client) {
  if (monitorTimer) {
    return;
  }

  const intervalSeconds = parseIntervalSeconds();
  const intervalMs = intervalSeconds * 1000;

  // 初回実行（30秒後）
  setTimeout(() => {
    monitorCycle(client).catch((error) => {
      log(`osu! リアルタイムスコア監視初回実行失敗: ${error.message}`, 'error');
    });
  }, 30_000);

  // 定期実行
  monitorTimer = setInterval(() => {
    monitorCycle(client).catch((error) => {
      log(`osu! リアルタイムスコア監視定期実行失敗: ${error.message}`, 'error');
    });
  }, intervalMs);

  log(`osu! リアルタイムスコア監視を開始 (間隔: ${intervalSeconds}秒)`, 'success');
}

export function stopOsuRealtimeScoreMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    processedScores.clear();
    log('osu! リアルタイムスコア監視を停止', 'info');
  }
}
