import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { getAuthSettings } from '../database/authSettings.js';
import { resolveUserLanguage, translate, translateAll } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const AUTH_QUESTIONS = [
  { id: 'q1', text: '1 + 1 = ?', answer: 2 },
  { id: 'q2', text: '2 + 3 = ?', answer: 5 },
  { id: 'q3', text: '4 + 1 = ?', answer: 5 },
  { id: 'q4', text: '5 + 2 = ?', answer: 7 },
  { id: 'q5', text: '3 + 4 = ?', answer: 7 }
];

const MODE_ROLE_OPTIONS = [
  { label: 'std', value: 'std' },
  { label: 'mania', value: 'mania' },
  { label: 'taiko', value: 'taiko' },
  { label: 'catch', value: 'catch' }
];

function pickQuestion() {
  const index = Math.floor(Math.random() * AUTH_QUESTIONS.length);
  return AUTH_QUESTIONS[index];
}

function isManageableRole(role, botMember) {
  if (!role || role.managed || !botMember) {
    return false;
  }
  return role.position < botMember.roles.highest.position;
}

function buildModeRoleRow(userId, lang) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`auth-mode-roles:${userId}`)
    .setPlaceholder(translate(lang, 'auth.modePrompt'))
    .setMinValues(0)
    .setMaxValues(MODE_ROLE_OPTIONS.length)
    .addOptions(MODE_ROLE_OPTIONS);

  return new ActionRowBuilder().addComponents(menu);
}

export const data = new SlashCommandBuilder()
  .setName('auth')
  .setDescription('簡単な計算に答えて認証ロールを取得します');

export async function showAuthModal(interaction) {
  const lang = await resolveUserLanguage(interaction.user.id);

  if (!interaction.guildId) {
    return interaction.reply({
      content: translate(lang, 'common.guildOnly'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  try {
    const settings = await getAuthSettings(interaction.guildId);
    if (!settings.verified_role_id) {
      return interaction.reply({
        content: translate(lang, 'auth.roleNotSet'),
        flags: [MessageFlags.Ephemeral]
      });
    }

    const question = pickQuestion();
    const issuedAt = Date.now();
    const modal = new ModalBuilder()
      .setCustomId(`auth-verify:${question.id}:${issuedAt}`)
      .setTitle('認証テスト');

    const answerInput = new TextInputBuilder()
      .setCustomId('answer')
      .setLabel(question.text)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('数字で入力')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
    await interaction.showModal(modal);
  } catch (error) {
    log(`/auth エラー: ${error.message}`, 'error');
    await interaction.reply({
      content: translate(lang, 'auth.failed'),
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export async function execute(interaction) {
  return showAuthModal(interaction);
}

export async function handleAuthModalSubmit(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({
      content: '❌ サーバー内で実行してください',
      flags: [MessageFlags.Ephemeral]
    });
  }

  const [, questionId, issuedAtRaw] = interaction.customId.split(':');
  const question = AUTH_QUESTIONS.find(item => item.id === questionId);
  const lang = await resolveUserLanguage(interaction.user.id);
  if (!question) {
    return interaction.reply({
      content: translate(lang, 'auth.questionMissing'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 60 * 1000) {
    return interaction.reply({
      content: translate(lang, 'auth.timeLimit'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  const rawAnswer = interaction.fields.getTextInputValue('answer');
  const numericAnswer = Number(rawAnswer);
  if (!Number.isFinite(numericAnswer)) {
    return interaction.reply({
      content: translate(lang, 'auth.numericOnly'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  if (numericAnswer !== question.answer) {
    return interaction.reply({
      content: translate(lang, 'auth.wrong'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  try {
    const settings = await getAuthSettings(interaction.guildId);
    if (!settings.verified_role_id) {
      return interaction.reply({
        content: translate(lang, 'auth.roleNotSet'),
        flags: [MessageFlags.Ephemeral]
      });
    }

    const member = interaction.member;
    if (!member || !('roles' in member)) {
      return interaction.reply({
        content: translate(lang, 'auth.memberMissing'),
        flags: [MessageFlags.Ephemeral]
      });
    }

    const role = interaction.guild.roles.cache.get(settings.verified_role_id);
    if (!role) {
      return interaction.reply({
        content: translate(lang, 'auth.roleMissing'),
        flags: [MessageFlags.Ephemeral]
      });
    }

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!isManageableRole(role, botMember)) {
      return interaction.reply({
        content: translate(lang, 'auth.roleNotManageable'),
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (member.roles.cache.has(role.id)) {
      return interaction.reply({
        content: translate(lang, 'auth.alreadyVerified', { role: `${role}` }),
        flags: [MessageFlags.Ephemeral]
      });
    }

    await member.roles.add(role);
    await interaction.reply({
      content: translateAll('auth.success', { role: `${role}` }),
      flags: [MessageFlags.Ephemeral]
    });

    const row = buildModeRoleRow(interaction.user.id, lang);
    await interaction.followUp({
      content: translate(lang, 'auth.modePrompt'),
      components: [row],
      flags: [MessageFlags.Ephemeral]
    });
    return null;
  } catch (error) {
    log(`/auth モーダル処理エラー: ${error.message}`, 'error');
    return interaction.reply({
      content: translate(lang, 'auth.assignFailed'),
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export async function handleModeRoleSelect(interaction) {
  const lang = await resolveUserLanguage(interaction.user.id);
  const [, targetUserId] = interaction.customId.split(':');

  if (targetUserId && targetUserId !== interaction.user.id) {
    return interaction.reply({
      content: translate(lang, 'auth.modeUnauthorized'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  if (!interaction.guildId) {
    return interaction.reply({
      content: translate(lang, 'common.guildOnly'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  const member = interaction.member;
  if (!member || !('roles' in member)) {
    return interaction.reply({
      content: translate(lang, 'auth.memberMissing'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return interaction.reply({
      content: translate(lang, 'auth.roleNotManageable'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  const selections = Array.isArray(interaction.values) ? interaction.values : [];
  const roleMap = new Map();

  for (const option of MODE_ROLE_OPTIONS) {
    const role = interaction.guild.roles.cache.find(item => item.name === option.value);
    if (role) {
      roleMap.set(option.value, role);
    }
  }

  const manageableRoles = [...roleMap.values()].filter(role => isManageableRole(role, botMember));
  const manageableIds = manageableRoles.map(role => role.id);
  const selectedRoles = selections
    .map(value => roleMap.get(value))
    .filter(role => isManageableRole(role, botMember));

  const selectedIds = new Set(selectedRoles.map(role => role.id));
  const removeIds = manageableIds.filter(id => !selectedIds.has(id) && member.roles.cache.has(id));

  if (removeIds.length > 0) {
    await member.roles.remove(removeIds).catch(() => null);
  }

  const addRoles = selectedRoles.filter(role => !member.roles.cache.has(role.id));
  if (addRoles.length > 0) {
    await member.roles.add(addRoles).catch(() => null);
  }

  if (selectedRoles.length === 0) {
    return interaction.reply({
      content: translate(lang, 'auth.modeCleared'),
      flags: [MessageFlags.Ephemeral]
    });
  }

  return interaction.reply({
    content: translate(lang, 'auth.modeUpdated', {
      roles: selectedRoles.map(role => role.name).join(', ')
    }),
    flags: [MessageFlags.Ephemeral]
  });
}
