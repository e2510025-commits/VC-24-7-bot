import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const NOTIFY_ROLE_NAMES = [
  'notifycation-std',
  'notifycation-mania',
  'notifycation-ctb',
  'notifycation-taiko'
];

function requireAdmin(interaction) {
  const member = interaction.member;
  if (!member || !('permissions' in member)) {
    return false;
  }
  return member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export const data = new SlashCommandBuilder()
  .setName('notify-role-setup')
  .setDescription('募集通知用ロールを作成します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

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

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!me || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.editReply(translate(lang, 'common.botNoRolePerm'));
    }

    const created = [];
    const skipped = [];

    for (const name of NOTIFY_ROLE_NAMES) {
      const existing = interaction.guild.roles.cache.find(role => role.name === name);
      if (existing) {
        skipped.push(name);
        continue;
      }

      try {
        const role = await interaction.guild.roles.create({
          name,
          permissions: [],
          reason: `${interaction.user.tag} が通知ロール作成`
        });
        created.push(role.name);
      } catch (error) {
        log(`notify-role-setup 失敗: ${name} - ${error.message}`, 'error');
      }
    }

    const lines = [];
    if (created.length > 0) {
      lines.push(translate(lang, 'notifyRoleSetup.created', { roles: created.join(', ') }));
    }
    if (skipped.length > 0) {
      lines.push(translate(lang, 'notifyRoleSetup.exists', { roles: skipped.join(', ') }));
    }
    if (lines.length === 0) {
      lines.push(translate(lang, 'notifyRoleSetup.none'));
    }

    return interaction.editReply(lines.join('\n'));
  } catch (error) {
    log(`/notify-role-setup エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'notifyRoleSetup.failed'));
  }
}
