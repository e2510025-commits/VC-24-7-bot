import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const MODE_ROLE_MAP = {
  std: 'notifycation-std',
  mania: 'notifycation-mania',
  ctb: 'notifycation-ctb',
  taiko: 'notifycation-taiko'
};

const COOLDOWN_MS = 60 * 60 * 1000;
const userCooldowns = new Map();

function getRemainingMinutes(lastUsed) {
  const elapsed = Date.now() - lastUsed;
  const remainingMs = Math.max(0, COOLDOWN_MS - elapsed);
  return Math.ceil(remainingMs / 60000);
}

async function ensureNotifyRole(interaction, roleName, lang) {
  const guild = interaction.guild;
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!me) {
    return { error: translate(lang, 'notify.botMissing') };
  }

  let role = guild.roles.cache.find(item => item.name === roleName) || null;
  if (!role) {
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { error: translate(lang, 'common.botNoRolePerm') };
    }

    try {
      role = await guild.roles.create({
        name: roleName,
        mentionable: true,
        permissions: [],
        reason: `${interaction.user.tag} が募集通知ロール作成`
      });
    } catch (error) {
      log(`/notify ロール作成失敗: ${roleName} - ${error.message}`, 'error');
      return { error: translate(lang, 'notify.roleCreateFailed', { role: roleName }) };
    }
  }

  if (!role.mentionable && !me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
    if (me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      try {
        await role.setMentionable(true, '募集通知ロールをメンション可能に変更');
      } catch (error) {
        log(`/notify ロール更新失敗: ${roleName} - ${error.message}`, 'error');
        return { error: translate(lang, 'notify.roleUpdateFailed', { role: roleName }) };
      }
    } else {
      return { error: translate(lang, 'notify.botNoMentionPerm', { role: roleName }) };
    }
  }

  return { role, me };
}

export const data = new SlashCommandBuilder()
  .setName('notify')
  .setDescription('募集を通知します')
  .addStringOption(option =>
    option
      .setName('mode')
      .setDescription('募集するモード')
      .setRequired(true)
      .addChoices(
        { name: 'std', value: 'std' },
        { name: 'mania', value: 'mania' },
        { name: 'ctb', value: 'ctb' },
        { name: 'taiko', value: 'taiko' }
      )
  )
  .addStringOption(option =>
    option
      .setName('text')
      .setDescription('募集内容')
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const lang = await resolveUserLanguage(interaction.user.id);

  try {
    if (!interaction.guild) {
      return interaction.editReply(translate(lang, 'common.guildOnly'));
    }

    if (!interaction.channel || !interaction.channel.isTextBased()) {
      return interaction.editReply(translate(lang, 'notify.channelOnly'));
    }

    const lastUsed = userCooldowns.get(interaction.user.id);
    if (lastUsed && Date.now() - lastUsed < COOLDOWN_MS) {
      const minutes = getRemainingMinutes(lastUsed);
      return interaction.editReply(translate(lang, 'notify.cooldown', { minutes }));
    }

    const mode = interaction.options.getString('mode', true);
    const roleName = MODE_ROLE_MAP[mode];
    const { role, error } = await ensureNotifyRole(interaction, roleName, lang);
    if (!role || error) {
      return interaction.editReply(error || translate(lang, 'common.commandFailed'));
    }

    const rawText = interaction.options.getString('text') || '';
    const messageText = rawText.trim() || translate(lang, 'notify.defaultText');

    await interaction.channel.send({
      content: `${role} ${messageText}`,
      allowedMentions: { roles: [role.id] }
    });

    userCooldowns.set(interaction.user.id, Date.now());
    return interaction.editReply(translate(lang, 'notify.sent', { role: `${role}` }));
  } catch (error) {
    log(`/notify エラー: ${error.message}`, 'error');
    return interaction.editReply(translate(lang, 'common.commandFailed'));
  }
}
