import { SlashCommandBuilder, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('音楽を検索して再生します')
  .addStringOption(option =>
    option.setName('曲名')
      .setDescription('検索する曲名またはURL')
      .setRequired(true)
  );

export async function execute(interaction, musicPlayer) {
  // 最優先で deferReply を実行（3秒ルールを守る）
  try {
    await interaction.deferReply();
  } catch (error) {
    log(`deferReply エラー: ${error.message}`, 'error');
    return;
  }

  const lang = await resolveUserLanguage(interaction.user.id);

  const query = interaction.options.getString('曲名');
  const member = interaction.member;

  // ボイスチャンネルチェック（即座に実行）
  if (!member.voice.channel) {
    try {
      return await interaction.editReply(translate(lang, 'music.joinPrompt'));
    } catch (error) {
      log(`editReply エラー: ${error.message}`, 'error');
      return;
    }
  }

  try {
    log(`検索開始: ${query}`, 'music');
    
    // タイムアウト付きで検索実行（28秒 - deferReplyの猶予を考慮）
    const searchPromise = musicPlayer.search(query);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('検索がタイムアウトしました')), 28000)
    );
    
    let result;
    try {
      result = await Promise.race([searchPromise, timeoutPromise]);
    } catch (searchError) {
      log(`検索エラー: ${searchError.message}`, 'error');
      return await interaction.editReply(translate(lang, 'music.searchFailed'));
    }

    if (!result.success || !result.tracks || result.tracks.length === 0) {
      const fallback = translate(lang, 'music.trackNotFound');
      const errorMsg = result.error || fallback.replace(/^❌\s*/, '');
      return await interaction.editReply(`❌ ${errorMsg}`);
    }

    // URLの場合は直接再生
    if (query.startsWith('http')) {
      const queue = musicPlayer.getQueue(interaction.guildId);
      queue.textChannel = interaction.channel; // チャンネルを記憶
      queue.tracks.push(result.tracks[0]);

      if (!queue.current) {
        try {
          await musicPlayer.play(interaction.guildId, member.voice.channelId);
        } catch (playError) {
          log(`再生エラー: ${playError.message}`, 'error');
          
          // RestError の詳細をログ
          if (playError.body) {
            log(`RestError body: ${JSON.stringify(playError.body)}`, 'error');
          }
          
          return await interaction.editReply(
            translate(lang, 'music.queueAddFailed', { error: playError.message })
          );
        }
      }

      return await interaction.editReply(
        translate(lang, 'music.queued', { title: result.tracks[0].info?.title || 'Unknown' })
      );
    }

    // 検索結果をSelect Menuで表示
    const options = result.tracks.map((track, index) => ({
      label: (track.info?.title || 'Unknown').substring(0, 100),
      description: `${track.info?.author || 'Unknown'} - ${formatDuration(track.info?.length || 0)}`.substring(0, 100),
      value: `track_${index}`
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`select_track_${interaction.user.id}`)
      .setPlaceholder(translate(lang, 'music.selectPrompt'))
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle(translate(lang, 'music.searchTitle'))
      .setDescription(
        translate(lang, 'music.searchDescription', {
          query,
          count: result.tracks.length
        })
      )
      .setFooter({ text: translate(lang, 'music.selectFooter') });

    const response = await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

    // 検索結果を一時保存
    const collector = response.createMessageComponentCollector({
      filter: i => i.customId === `select_track_${interaction.user.id}` && i.user.id === interaction.user.id,
      time: 60000
    });

    collector.on('collect', async (i) => {
      try {
        // 【最重要】真っ先に i.update を実行してタイムアウトを防止
        await i.update({
          content: translate(lang, 'music.queueing'),
          embeds: [],
          components: []
        });

        const trackIndex = parseInt(i.values[0].split('_')[1]);
        const selectedTrack = result.tracks[trackIndex];

        const queue = musicPlayer.getQueue(interaction.guildId);
        queue.textChannel = interaction.channel; // チャンネルを記憶
        queue.tracks.push(selectedTrack);

        // 追加完了メッセージに更新
        await interaction.editReply({
          content: translate(lang, 'music.queued', {
            title: selectedTrack.info?.title || 'Unknown'
          }),
          embeds: [],
          components: []
        });

        if (!queue.current) {
          try {
            await musicPlayer.play(interaction.guildId, member.voice.channelId);
          } catch (playError) {
            log(`再生開始エラー: ${playError.message}`, 'error');
            log(`エラースタック: ${playError.stack}`, 'error');
            
            // RestError の詳細をログ
            if (playError.body) {
              log(`RestError body: ${JSON.stringify(playError.body)}`, 'error');
            }
            
            // 再生エラーは別途通知
            await interaction.followUp({
              content: translate(lang, 'music.playStartFailed', {
                error: playError.message
              }),
              flags: [MessageFlags.Ephemeral]
            }).catch(() => {});
          }
        }

        collector.stop();
      } catch (error) {
        log(`選択処理エラー: ${error.message}`, 'error');
        log(`エラースタック: ${error.stack}`, 'error');
        
        // エラー時も適切に応答
        try {
          await interaction.editReply({
            content: translate(lang, 'music.trackAddFailed'),
            embeds: [],
            components: []
          });
        } catch (updateError) {
          log(`update エラー: ${updateError.message}`, 'error');
        }
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'time') {
        interaction.editReply({
          content: translate(lang, 'music.selectTimeout'),
          embeds: [],
          components: []
        }).catch(error => log(`タイムアウト通知エラー: ${error.message}`, 'error'));
      }
    });
  } catch (error) {
    log(`/play コマンドエラー: ${error.message}`, 'error');
    log(`エラースタック: ${error.stack}`, 'error');
    
    try {
      await interaction.editReply(translate(lang, 'music.searchFailed'));
    } catch (replyError) {
      log(`エラー応答の送信に失敗: ${replyError.message}`, 'error');
    }
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
