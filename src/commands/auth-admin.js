import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getAuthSettings, upsertAuthSettings } from '../database/authSettings.js';
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

  try {
    if (!interaction.guildId) {
      return interaction.editReply('❌ サーバー内で実行してください');
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply('❌ このコマンドはサーバー管理者のみ実行できます');
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'show') {
      const settings = await getAuthSettings(interaction.guildId);
      return interaction.editReply(
        `✅ 認証ロール: ${roleLabel(settings.verified_role_id)}`
      );
    }

    if (subcommand === 'set-role') {
      const role = interaction.options.getRole('role');
      await upsertAuthSettings(interaction.guildId, {
        verified_role_id: role?.id || null
      });

      if (role) {
        return interaction.editReply(`✅ 認証ロールを ${role} に設定しました`);
      }

      return interaction.editReply('✅ 認証ロールを解除しました');
    }

    return interaction.editReply('❌ 不明なサブコマンドです');
  } catch (error) {
    log(`/auth-admin エラー: ${error.message}`, 'error');
    return interaction.editReply(`❌ 設定更新中にエラーが発生しました: ${error.message}`);
  }
}
