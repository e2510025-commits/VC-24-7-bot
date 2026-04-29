import {
  ChannelType,
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
  .setName('clone-category')
  .setDescription('カテゴリとチャンネルを複製します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(option =>
    option
      .setName('source')
      .setDescription('複製元のカテゴリ')
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('name')
      .setDescription('新しいカテゴリ名')
      .setRequired(true)
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

    const source = interaction.options.getChannel('source', true);
    if (source.type !== ChannelType.GuildCategory) {
      return interaction.editReply(translate(lang, 'cloneCategory.notCategory'));
    }

    const name = interaction.options.getString('name', true).trim();
    if (!name) {
      return interaction.editReply(translate(lang, 'cloneCategory.invalidName'));
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.editReply(translate(lang, 'cloneCategory.noPerm'));
    }

    const newCategory = await interaction.guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: source.permissionOverwrites.cache.map(overwrite => ({
        id: overwrite.id,
        allow: overwrite.allow,
        deny: overwrite.deny,
        type: overwrite.type
      })),
      reason: `${interaction.user.tag} がカテゴリ複製を実行`
    });

    const children = source.children.cache
      .filter(child => child.type !== ChannelType.GuildCategory)
      .sort((a, b) => a.position - b.position);

    let createdCount = 0;

    for (const channel of children.values()) {
      try {
        const cloned = await channel.clone({
          parent: newCategory,
          reason: `${interaction.user.tag} がカテゴリ複製を実行`
        });
        await cloned.setPosition(channel.position).catch(() => null);
        createdCount += 1;
      } catch (error) {
        log(`clone-category 失敗: ${channel.name} - ${error.message}`, 'error');
      }
    }

    return interaction.editReply(
      translate(lang, 'cloneCategory.done', {
        category: newCategory.name,
        count: createdCount
      })
    );
  } catch (error) {
    log(`/clone-category エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'cloneCategory.failed'));
  }
}
