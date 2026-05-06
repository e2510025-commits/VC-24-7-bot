import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export const data = new SlashCommandBuilder()
  .setName('auth-panel')
  .setDescription('認証パネルを設置します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand =>
    subcommand
      .setName('post')
      .setDescription('認証パネルを送信します')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('設置先のチャンネル')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  );

function buildAuthPanelEmbed(lang) {
  return new EmbedBuilder()
    .setColor('#2D9CDB')
    .setTitle(translate(lang, 'authPanel.title'))
    .setDescription(translate(lang, 'authPanel.description'))
    .setFooter({ text: translate(lang, 'authPanel.footer') });
}

function buildAuthPanelRow(lang) {
  const button = new ButtonBuilder()
    .setCustomId('auth-panel:open')
    .setLabel(translate(lang, 'authPanel.button'))
    .setStyle(ButtonStyle.Primary);

  return new ActionRowBuilder().addComponents(button);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guild) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply(translate(lang, 'common.adminOnly'));
    }

    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) {
      return interaction.editReply(translate(lang, 'authPanel.notText'));
    }

    const embed = buildAuthPanelEmbed(lang);
    const row = buildAuthPanelRow(lang);

    await channel.send({ embeds: [embed], components: [row] });
    return interaction.editReply(
      translate(lang, 'authPanel.posted', { channel: `${channel}` })
    );
  } catch (error) {
    log(`/auth-panel エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'authPanel.failed'));
  }
}
