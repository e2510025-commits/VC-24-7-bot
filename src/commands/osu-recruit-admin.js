import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import { getGuildOsuSettings, upsertGuildOsuSettings } from '../database/osuGuildSettings.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function channelLabel(id, lang) {
  if (!id) return translate(lang, 'common.unset');
  return `<#${id}>`;
}

export const data = new SlashCommandBuilder()
  .setName('osu-recruit-admin')
  .setDescription('osu!募集の設定を管理します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand =>
    subcommand
      .setName('show')
      .setDescription('現在の募集チャンネルを表示します')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-channel')
      .setDescription('募集チャンネルを設定します')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('設定するテキストチャンネル')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guildId) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply(translate(lang, 'common.adminOnly'));
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'show') {
      const settings = await getGuildOsuSettings(interaction.guildId);
      return interaction.editReply(
        translate(lang, 'osuRecruitAdmin.show', {
          channel: channelLabel(settings.recruit_channel_id, lang)
        })
      );
    }

    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased()) {
      return interaction.editReply(translate(lang, 'osuRecruitAdmin.channelNotText'));
    }

    await upsertGuildOsuSettings(interaction.guildId, { recruit_channel_id: channel.id });
    return interaction.editReply(
      translate(lang, 'osuRecruitAdmin.channelSet', { channel: `${channel}` })
    );
  } catch (error) {
    log(`/osu-recruit-admin エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'osuRecruitAdmin.failed'));
  }
}
