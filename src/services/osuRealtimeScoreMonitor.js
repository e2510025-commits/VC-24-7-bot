import { EmbedBuilder } from 'discord.js';
import { listTrackedOsuUsers } from '../database/osuTrackedUsers.js';
import { getGuildOsuSettings } from '../database/osuGuildSettings.js';
import { fetchRecentScores, getModeLabel, formatNumber, normalizeOsuMode } from '../utils/osuApi.js';
import { log } from '../utils/logger.js';

let monitorTimer = null;
let isRunning = false;
const processedScores = new Set();
const userStatsCache = new Map(); // ユーザーごとの最新統計をキャッシュ
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

function buildScoreEmbed({ user, mode, score, userStats, previousStats }) {
  const beatmap = score?.beatmap || {};
  const beatmapset = score?.beatmapset || {};
  const statistics = score?.statistics || {};
  
  const mods = Array.isArray(score?.mods) && score.mods.length > 0
    ? score.mods.join(', ')
    : 'NM';
  
  const title = `${beatmapset.artist || 'Unknown Artist'} - ${beatmapset.title || 'Unknown Title'} [${beatmap.version || 'Unknown Diff'}]`;
  
  // 譜面リンク（beatmapset形式）
  const beatmapsetId = beatmapset?.id;
  const beatmapId = beatmap?.id;
  const beatmapUrl = beatmapsetId && beatmapId
    ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}#${mode}/${beatmapId}`
    : beatmapsetId
    ? `https://osu.ppy.sh/beatmapsets/${beatmapsetId}`
    : null;
  
  // リプレイダウンロードリンク（モード指定なし）
  const replayUrl = score?.id
    ? `https://osu.ppy.sh/scores/${score.id}/download`
    : null;
  
  const pp = toFiniteNumber(score?.pp);
  const accuracy = toFiniteNumber(score?.accuracy);
  const maxCombo = toFiniteNumber(score?.max_combo);
  const miss = toFiniteNumber(statistics?.miss);
  const rank = score?.rank || 'F';
  
  // 順位情報
  const currentRank = toFiniteNumber(userStats?.global_rank);
  const previousRank = toFiniteNumber(previousStats?.global_rank);
  let rankText = currentRank ? `#${formatNumber(currentRank)}` : 'N/A';
  
  if (currentRank && previousRank && previousRank > 0) {
    const rankDiff = previousRank - currentRank;
    if (rankDiff > 0) {
      rankText += ` (▲${formatNumber(rankDiff)})`;
    } else if (rankDiff < 0) {
      rankText += ` (▼${formatNumber(Math.abs(rankDiff))})`;
    }
  }
  
  // PP情報
  const currentPp = toFiniteNumber(userStats?.pp);
  const previousPp = toFiniteNumber(previousStats?.pp);
  let ppText = currentPp ? `${currentPp.toFixed(2)}pp` : 'N/A';
  
  if (currentPp && previousPp) {
    const ppDiff = currentPp - previousPp;
    if (ppDiff > 0) {
      ppText += ` (+${ppDiff.toFixed(2)})`;
    } else if (ppDiff < 0) {
      ppText += ` (${ppDiff.toFixed(2)})`;
    }
  }
  
  // リンク行を作成
  const links = [];
  if (beatmapUrl) {
    links.push(`[譜面](${beatmapUrl})`);
  }
  if (replayUrl) {
    links.push(`[リプレイ・ダウンロード](${replayUrl})`);
  }
  const linksText = links.length > 0 ? links.join(' • ') : '';
  
  const embed = new EmbedBuilder()
    .setColor('#FF66AA')
    .setTitle(`${user.username} [${getModeLabel(mode)}]`)
    .setURL(beatmapUrl || `https://osu.ppy.sh/users/${user.id}`)
    .setDescription(`**${title}**${linksText ? `\n${linksText}` : ''}`)
    .addFields(
      {
        name: 'スコアPP',
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
      },
      {
        name: '総合PP',
        value: ppText,
        inline: true
      },
      {
        name: 'グローバル順位',
        value: rankText,
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
      let osuUserId = toFiniteNumber(trackedUser.osu_user_id);
      let osuUsername = String(trackedUser.osu_username || '').trim();

      if (!discordId || !osuUsername) {
        log(`スキップ: discordId=${discordId}, osuUsername="${osuUsername}"`, 'info');
        continue;
      }

      log(`処理中: ${osuUsername} (ID: ${osuUserId || 'なし'})`, 'info');

      // osuUserIdが0または無効な場合、ユーザー情報を再取得して更新
      if (!osuUserId || osuUserId === 0) {
        try {
          const { fetchOsuUser } = await import('../utils/osuApi.js');
          const { upsertTrackedOsuUser } = await import('../database/osuTrackedUsers.js');
          
          log(`osu! ユーザーID取得試行: ${osuUsername}`, 'info');
          const user = await fetchOsuUser(osuUsername, modes[0]);
          osuUserId = user.id;
          osuUsername = user.username; // 正規化されたユーザー名を使用
          
          // データベースを更新
          await upsertTrackedOsuUser({
            discordId,
            osuUserId: user.id,
            osuUsername: user.username
          });
          
          log(`osu! ユーザーID更新成功: ${user.username} (ID: ${user.id})`, 'success');
        } catch (error) {
          log(`osu! ユーザーID取得失敗: ${osuUsername} - ${error.message}`, 'error');
          log(`エラースタック: ${error.stack}`, 'error');
          continue;
        }
      }

      for (const mode of modes) {
        try {
          // ユーザー情報を取得（統計情報含む）
          const { fetchOsuUser } = await import('../utils/osuApi.js');
          
          const user = await fetchOsuUser(osuUserId, mode);
          const userStats = user.statistics || {};
          
          // キャッシュキー
          const cacheKey = `${osuUserId}:${mode}`;
          
          // 前回キャッシュされた統計を取得
          const previousStats = userStatsCache.get(cacheKey) || null;
          
          // 最新5件のスコアを取得（ユーザーIDを使用）
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
                username: osuUsername
              },
              mode,
              score,
              userStats,
              previousStats
            });

            const sent = await sendScoreToGuildChannels(
              client,
              guildSettingsMap,
              discordId,
              embed
            );

            if (sent > 0) {
              scoreCount += 1;
              
              // スコア投稿成功後、現在の統計をキャッシュに保存
              userStatsCache.set(cacheKey, {
                pp: userStats.pp,
                global_rank: userStats.global_rank
              });
            }

            processedScores.add(scoreKey);
          }
        } catch (error) {
          log(`osu! リアルタイムスコア取得失敗: ${osuUsername} [${mode}] - ${error.message}`, 'error');
          log(`エラー詳細: discordId=${discordId}, osuUserId=${osuUserId}, osuUsername=${osuUsername}`, 'error');
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
    userStatsCache.clear();
    log('osu! リアルタイムスコア監視を停止', 'info');
  }
}
