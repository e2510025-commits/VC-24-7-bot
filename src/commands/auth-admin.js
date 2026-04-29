import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getAuthSettings, upsertAuthSettings } from '../database/authSettings.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

function roleLabel(id) {
  if (!id) return '未設定';
  return `<@&${id}>`;
}

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export const data = new SlashCommandBuilder()
  .setName('auth-admin')
  .setDescription('認証ロール設定を管理します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(subcommand =>
    subcommand
      .setName('show')
      .setDescription('現在の認証ロール設定を表示します')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('set-role')
      .setDescription('認証成功時に付与するロールを設定します')
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('設定するロール（省略で解除）')
          .setRequired(false)
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
      const settings = await getAuthSettings(interaction.guildId);
      return interaction.editReply(
        translate(lang, 'authAdmin.show', { role: roleLabel(settings.verified_role_id) })
      );
    }

    if (subcommand === 'set-role') {
      const role = interaction.options.getRole('role');
      await upsertAuthSettings(interaction.guildId, {
        verified_role_id: role?.id || null
      });

      if (role) {
        return interaction.editReply(
          translate(lang, 'authAdmin.roleSet', { role: `${role}` })
        );
      }

      return interaction.editReply(translate(lang, 'authAdmin.roleCleared'));
    }

    return interaction.editReply(translate(lang, 'common.unknownSubcommand'));
  } catch (error) {
    log(`/auth-admin エラー: ${error.message}`, 'error');
    return interaction.editReply(`❌ 設定更新中にエラーが発生しました: ${error.message}`);
  }
}
