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

function buildAuthPanelEmbed() {
  return new EmbedBuilder()
    .setColor('#2D9CDB')
    .setTitle('認証 / Verification / 인증')
    .setDescription(
      '日本語: 下の「認証」ボタンを押して、簡単な計算に答えてください。\n' +
      'English: Press the "Verify" button below and answer a simple math question.\n' +
      '한국어: 아래 "인증" 버튼을 눌러 간단한 계산 문제를 풀어주세요.'
    )
    .setFooter({ text: 'osu! 連携は /osu-link' });
}

function buildAuthPanelRow() {
  const button = new ButtonBuilder()
    .setCustomId('auth-panel:open')
    .setLabel('認証 / Verify / 인증')
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

    const embed = buildAuthPanelEmbed();
    const row = buildAuthPanelRow();

    await channel.send({ embeds: [embed], components: [row] });
    return interaction.editReply(
      translate(lang, 'authPanel.posted', { channel: `${channel}` })
    );
  } catch (error) {
    log(`/auth-panel エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'authPanel.failed'));
  }
}
