import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { log } from '../utils/logger.js';

const PLAY_TIME_ROLE_NAMES = [
  '1day',
  '3day',
  '5day',
  '10day',
  '30day',
  '50day',
  '100day'
];

const PP_ROLE_NAMES = [
  '100pp',
  '500pp',
  '1000pp',
  '1500pp',
  '2000pp',
  '4000pp',
  '5000pp',
  '6000pp',
  '7000pp',
  '8000pp',
  '9000pp',
  '10000pp'
];

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export const data = new SlashCommandBuilder()
  .setName('osu-role-setup')
  .setDescription('osu!自動付与ロールを作成します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    if (!interaction.guild) {
      return interaction.editReply('❌ サーバー内で実行してください');
    }

    if (!requireAdmin(interaction)) {
      return interaction.editReply('❌ このコマンドはサーバー管理者のみ実行できます');
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply('❌ Botにロール管理権限がありません');
    }

    const roleNames = [...PLAY_TIME_ROLE_NAMES, ...PP_ROLE_NAMES];
    const created = [];
    const skipped = [];

    for (const name of roleNames) {
      const existing = interaction.guild.roles.cache.find(role => role.name === name);
      if (existing) {
        skipped.push(name);
        continue;
      }

      try {
        const role = await interaction.guild.roles.create({
          name,
          permissions: [],
          reason: `${interaction.user.tag} がosu!ロール作成`
        });
        created.push(role.name);
      } catch (error) {
        log(`osu-role-setup 失敗: ${name} - ${error.message}`, 'error');
      }
    }

    const lines = [];
    if (created.length > 0) {
      lines.push(`✅ 作成: ${created.join(', ')}`);
    }
    if (skipped.length > 0) {
      lines.push(`ℹ️ 既存: ${skipped.join(', ')}`);
    }
    if (lines.length === 0) {
      lines.push('❌ ロールを作成できませんでした。権限やロール上限を確認してください。');
    }

    return interaction.editReply(lines.join('\n'));
  } catch (error) {
    log(`/osu-role-setup エラー: ${error.message}`, 'error');
    return interaction.editReply('❌ ロール作成中にエラーが発生しました');
  }
}
