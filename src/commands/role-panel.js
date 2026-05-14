import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from 'discord.js';
import {
  deleteRolePanelItem,
  getRolePanelItemByEmoji,
  getRolePanelSettings,
  listRolePanelItems,
  upsertRolePanelItem,
  upsertRolePanelSettings
} from '../database/rolePanels.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const CUSTOM_EMOJI_REGEX = /^<a?:([^:>]+):(\d+)>$/;
const RAW_CUSTOM_EMOJI_REGEX = /^([^:]+):(\d+)$/;

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

function parseEmojiInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return null;
  }

  const customMatch = trimmed.match(CUSTOM_EMOJI_REGEX);
  if (customMatch) {
    const name = customMatch[1];
    const id = customMatch[2];
    const animated = trimmed.startsWith('<a:');
    return {
      key: `${name}:${id}`,
      label: `<${animated ? 'a' : ''}:${name}:${id}>`
    };
  }

  const rawMatch = trimmed.match(RAW_CUSTOM_EMOJI_REGEX);
  if (rawMatch) {
    const name = rawMatch[1];
    const id = rawMatch[2];
    return {
      key: `${name}:${id}`,
      label: `<:${name}:${id}>`
    };
  }

  return {
    key: trimmed,
    label: trimmed
  };
}

function isManageableRole(role, botMember) {
  if (!role || role.managed || !botMember) {
    return false;
  }
  return role.position < botMember.roles.highest.position;
}

function buildRolePanelEmbed(lang, description, items) {
  const lines = items.map(item => `${item.emoji_label} <@&${item.role_id}>`);

  return new EmbedBuilder()
    .setColor('#FDCB6E')
    .setTitle(translate(lang, 'rolePanel.title'))
    .setDescription(description)
    .addFields({
      name: translate(lang, 'rolePanel.listTitle'),
      value: lines.join('\n')
    });
}

export const data = new SlashCommandBuilder()
  .setName('role-panel')
  .setDescription('リアクションロール用のパネルを管理します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-channel')
      .setDescription('ロールパネルの送信先チャンネルを設定します')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('送信先のテキストチャンネル')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('ロールと絵文字を登録します')
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('付与するロール')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('emoji')
          .setDescription('対応する絵文字')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('remove')
      .setDescription('登録済みロールを削除します')
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('削除するロール')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('登録済みロールを表示します')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('post')
      .setDescription('ロールパネルを送信します')
      .addStringOption(option =>
        option
          .setName('description')
          .setDescription('パネル説明文 (省略可)')
          .setRequired(false)
      )
  );

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

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!botMember) {
      return interaction.editReply(translate(lang, 'rolePanel.botMissing'));
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'set-channel') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased()) {
        return interaction.editReply(translate(lang, 'rolePanel.channelNotText'));
      }

      await upsertRolePanelSettings(interaction.guildId, { channel_id: channel.id });
      return interaction.editReply(
        translate(lang, 'rolePanel.setChannel', { channel: `${channel}` })
      );
    }

    if (subcommand === 'add') {
      const role = interaction.options.getRole('role', true);
      const emojiInput = interaction.options.getString('emoji', true);
      const parsed = parseEmojiInput(emojiInput);
      if (!parsed) {
        return interaction.editReply(translate(lang, 'rolePanel.emojiInvalid'));
      }

      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply(translate(lang, 'common.botNoRolePerm'));
      }

      if (!isManageableRole(role, botMember)) {
        return interaction.editReply(translate(lang, 'rolePanel.roleNotManageable'));
      }

      const existingEmoji = await getRolePanelItemByEmoji(interaction.guildId, parsed.key).catch(() => null);
      if (existingEmoji && existingEmoji.role_id !== role.id) {
        return interaction.editReply(translate(lang, 'rolePanel.emojiInUse'));
      }

      await upsertRolePanelItem(interaction.guildId, {
        roleId: role.id,
        emojiKey: parsed.key,
        emojiLabel: parsed.label
      });

      return interaction.editReply(
        translate(lang, 'rolePanel.added', {
          role: `<@&${role.id}>`,
          emoji: parsed.label
        })
      );
    }

    if (subcommand === 'remove') {
      const role = interaction.options.getRole('role', true);
      const removed = await deleteRolePanelItem(interaction.guildId, role.id);
      if (!removed) {
        return interaction.editReply(translate(lang, 'rolePanel.notFound'));
      }

      return interaction.editReply(
        translate(lang, 'rolePanel.removed', { role: `<@&${role.id}>` })
      );
    }

    if (subcommand === 'list') {
      const items = await listRolePanelItems(interaction.guildId);
      if (items.length === 0) {
        return interaction.editReply(translate(lang, 'rolePanel.listEmpty'));
      }

      const lines = items.map(item => `${item.emoji_label} <@&${item.role_id}>`);
      return interaction.editReply(lines.join('\n'));
    }

    const descriptionInput = interaction.options.getString('description');
    const items = await listRolePanelItems(interaction.guildId);
    if (items.length === 0) {
      return interaction.editReply(translate(lang, 'rolePanel.listEmpty'));
    }

    const settings = await getRolePanelSettings(interaction.guildId);
    if (!settings.channel_id) {
      return interaction.editReply(translate(lang, 'rolePanel.channelNotSet'));
    }

    const channel = await interaction.client.channels.fetch(settings.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return interaction.editReply(translate(lang, 'rolePanel.channelNotText'));
    }

    const permissions = channel.permissionsFor(botMember);
    if (!permissions || !permissions.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory])) {
      return interaction.editReply(translate(lang, 'rolePanel.missingPerms'));
    }

    const description = descriptionInput
      ? descriptionInput
      : settings.description || translate(lang, 'rolePanel.defaultDescription');

    const embed = buildRolePanelEmbed(lang, description, items);
    const message = await channel.send({ embeds: [embed] });

    for (const item of items) {
      try {
        await message.react(item.emoji_label);
      } catch (error) {
        log(`role-panel リアクション失敗: ${item.emoji_label} - ${error.message}`, 'error');
      }
    }

    await upsertRolePanelSettings(interaction.guildId, {
      channel_id: channel.id,
      message_id: message.id,
      description
    });

    return interaction.editReply(
      translate(lang, 'rolePanel.posted', { channel: `${channel}` })
    );
  } catch (error) {
    log(`/role-panel エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'rolePanel.failed'));
  }
}
