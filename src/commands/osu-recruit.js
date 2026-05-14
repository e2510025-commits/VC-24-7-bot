import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { getGuildOsuSettings } from '../database/osuGuildSettings.js';
import { getModeLabel, normalizeOsuMode } from '../utils/osuApi.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const COOLDOWN_MS = 60 * 60 * 1000;
const cooldowns = new Map();

const MODE_CHOICES = [
  { name: 'std', value: 'osu' },
  { name: 'mania', value: 'mania' },
  { name: 'catch', value: 'fruits' },
  { name: 'taiko', value: 'taiko' }
];

function getCooldownKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getCooldownRemainingMs(guildId, userId) {
  const key = getCooldownKey(guildId, userId);
  const last = cooldowns.get(key) || 0;
  const remaining = COOLDOWN_MS - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function formatCooldownParts(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { minutes, seconds };
}

export const data = new SlashCommandBuilder()
  .setName('osu-recruit')
  .setDescription('osu!募集メッセージを送信します')
  .addStringOption(option =>
    option
      .setName('mode')
      .setDescription('対象モード')
      .addChoices(...MODE_CHOICES)
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('text')
      .setDescription('募集文')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('room_name')
      .setDescription('ルーム名')
      .setRequired(false)
  )
  .addStringOption(option =>
    option
      .setName('room_link')
      .setDescription('ルームリンク')
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guildId) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    const remaining = getCooldownRemainingMs(interaction.guildId, interaction.user.id);
    if (remaining > 0) {
      const { minutes, seconds } = formatCooldownParts(remaining);
      return interaction.editReply(
        translate(lang, 'osuRecruit.cooldown', { minutes, seconds })
      );
    }

    const settings = await getGuildOsuSettings(interaction.guildId);
    if (!settings.recruit_channel_id) {
      return interaction.editReply(translate(lang, 'osuRecruit.channelNotSet'));
    }

    const channel = await interaction.client.channels.fetch(settings.recruit_channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return interaction.editReply(translate(lang, 'osuRecruit.channelNotText'));
    }

    const botMember = interaction.guild?.members.me || await interaction.guild?.members.fetchMe().catch(() => null);
    if (!botMember || !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.editReply(translate(lang, 'osuRecruit.channelNoPerm'));
    }

    const modeInput = interaction.options.getString('mode');
    const mode = modeInput ? normalizeOsuMode(modeInput) : null;
    const modeLabel = mode ? getModeLabel(mode) : translate(lang, 'osuRecruit.modeAll');

    const text = interaction.options.getString('text') || translate(lang, 'osuRecruit.defaultText');
    const roomName = interaction.options.getString('room_name');
    const roomLink = interaction.options.getString('room_link');

    const fields = [];
    if (mode) {
      fields.push({
        name: translate(lang, 'osuRecruit.modeLabel'),
        value: modeLabel,
        inline: true
      });
    }

    if (roomName) {
      fields.push({
        name: translate(lang, 'osuRecruit.roomNameLabel'),
        value: roomName,
        inline: true
      });
    }

    if (roomLink) {
      fields.push({
        name: translate(lang, 'osuRecruit.roomLinkLabel'),
        value: roomLink,
        inline: false
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#FF7675')
      .setTitle(translate(lang, 'osuRecruit.title'))
      .setDescription(text)
      .setAuthor({
        name: interaction.user.tag,
        iconURL: interaction.user.displayAvatarURL()
      })
      .setFooter({ text: translate(lang, 'osuRecruit.modeLabel') + ': ' + modeLabel })
      .setTimestamp(new Date());

    if (fields.length > 0) {
      embed.addFields(fields);
    }

    await channel.send({ embeds: [embed] });
    cooldowns.set(getCooldownKey(interaction.guildId, interaction.user.id), Date.now());

    return interaction.editReply(translate(lang, 'osuRecruit.sent'));
  } catch (error) {
    log(`/osu-recruit エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'osuRecruit.failed'));
  }
}
