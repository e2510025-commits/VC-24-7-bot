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
    const role = interaction.guild.roles.cache.find(item => item.name === roleName);

    if (!role) {
      return interaction.editReply(translate(lang, 'notify.roleMissing', { role: roleName }));
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!me) {
      return interaction.editReply(translate(lang, 'notify.botMissing'));
    }

    if (!me.permissions.has(PermissionFlagsBits.MentionEveryone) && !role.mentionable) {
      return interaction.editReply(translate(lang, 'notify.botNoMentionPerm', { role: roleName }));
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
