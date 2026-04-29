import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { getAuthSettings } from '../database/authSettings.js';
import { getLinkedOsuUsername } from '../database/supabase.js';
import { OsuApiError, fetchOsuUser } from '../utils/osuApi.js';
import { resolveUserLanguage, translate, translateAll } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const AUTH_QUESTIONS = [
  { id: 'q1', text: '1 + 1 = ?', answer: 2 },
  { id: 'q2', text: '2 + 3 = ?', answer: 5 },
  { id: 'q3', text: '4 + 1 = ?', answer: 5 },
  { id: 'q4', text: '5 + 2 = ?', answer: 7 },
  { id: 'q5', text: '3 + 4 = ?', answer: 7 }
];

const MODE_ROLE_MAP = {
  osu: 'std',
  mania: 'mania',
  taiko: 'taiko',
  fruits: 'catch'
};

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

async function assignModeRoles(interaction) {
  if (!interaction.guildId) {
    return;
  }

  const linkedUsername = await getLinkedOsuUsername(interaction.user.id).catch(() => null);
  if (!linkedUsername) {
    return;
  }

  const member = interaction.member;
  if (!member || !('roles' in member)) {
    return;
  }

  const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
  if (!botMember) {
    return;
  }

  const modes = ['osu', 'mania', 'taiko', 'fruits'];

  for (const mode of modes) {
    try {
      const user = await fetchOsuUser(linkedUsername, mode);
      const stats = user.statistics || {};
      const playCount = Number(stats.play_count || 0);
      const pp = Number(stats.pp || 0);

      if (playCount <= 0 && pp <= 0) {
        continue;
      }

      const roleName = MODE_ROLE_MAP[mode];
      if (!roleName) {
        continue;
      }

      const role = interaction.guild.roles.cache.find(item => item.name === roleName);
      if (!isManageableRole(role, botMember)) {
        continue;
      }

      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => null);
      }
    } catch (error) {
      if (!(error instanceof OsuApiError)) {
        log(`認証モードロール付与失敗: ${linkedUsername} [${mode}] - ${error.message}`, 'error');
      }
    }
  }
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
    await assignModeRoles(interaction);
    return interaction.reply({
      content: translateAll('auth.success', { role: `${role}` }),
      flags: [MessageFlags.Ephemeral]
    });
  } catch (error) {
    log(`/auth モーダル処理エラー: ${error.message}`, 'error');
    return interaction.reply({
      content: translate(lang, 'auth.assignFailed'),
      flags: [MessageFlags.Ephemeral]
    });
  }
}
