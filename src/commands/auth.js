import {
  ActionRowBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import { getAuthSettings } from '../database/authSettings.js';
import { log } from '../utils/logger.js';

const AUTH_QUESTIONS = [
  { id: 'q1', text: '1 + 1 = ?', answer: 2 },
  { id: 'q2', text: '2 + 3 = ?', answer: 5 },
  { id: 'q3', text: '4 + 1 = ?', answer: 5 },
  { id: 'q4', text: '5 + 2 = ?', answer: 7 },
  { id: 'q5', text: '3 + 4 = ?', answer: 7 }
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

export const data = new SlashCommandBuilder()
  .setName('auth')
  .setDescription('簡単な計算に答えて認証ロールを取得します');

export async function execute(interaction) {
  if (!interaction.guildId) {
    return interaction.reply({
      content: '❌ サーバー内で実行してください',
      flags: [MessageFlags.Ephemeral]
    });
  }

  try {
    const settings = await getAuthSettings(interaction.guildId);
    if (!settings.verified_role_id) {
      return interaction.reply({
        content: '❌ 認証ロールが未設定です。管理者に `/auth-admin set-role` を依頼してください。',
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
      content: '❌ 認証処理でエラーが発生しました',
      flags: [MessageFlags.Ephemeral]
    });
  }
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
  if (!question) {
    return interaction.reply({
      content: '❌ 認証問題が見つかりませんでした。もう一度 `/auth` を実行してください。',
      flags: [MessageFlags.Ephemeral]
    });
  }

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 60 * 1000) {
    return interaction.reply({
      content: '❌ 制限時間を超過しました。もう一度 `/auth` を実行してください。',
      flags: [MessageFlags.Ephemeral]
    });
  }

  const rawAnswer = interaction.fields.getTextInputValue('answer');
  const numericAnswer = Number(rawAnswer);
  if (!Number.isFinite(numericAnswer)) {
    return interaction.reply({
      content: '❌ 数字で回答してください。',
      flags: [MessageFlags.Ephemeral]
    });
  }

  if (numericAnswer !== question.answer) {
    return interaction.reply({
      content: '❌ 不正解です。もう一度 `/auth` を実行してください。',
      flags: [MessageFlags.Ephemeral]
    });
  }

  try {
    const settings = await getAuthSettings(interaction.guildId);
    if (!settings.verified_role_id) {
      return interaction.reply({
        content: '❌ 認証ロールが未設定です。管理者に `/auth-admin set-role` を依頼してください。',
        flags: [MessageFlags.Ephemeral]
      });
    }

    const member = interaction.member;
    if (!member || !('roles' in member)) {
      return interaction.reply({
        content: '❌ サーバーメンバー情報の取得に失敗しました。',
        flags: [MessageFlags.Ephemeral]
      });
    }

    const role = interaction.guild.roles.cache.get(settings.verified_role_id);
    if (!role) {
      return interaction.reply({
        content: '❌ 認証ロールが見つかりません。管理者に確認してください。',
        flags: [MessageFlags.Ephemeral]
      });
    }

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!isManageableRole(role, botMember)) {
      return interaction.reply({
        content: '❌ Botの権限が不足しています。ロールの順序を確認してください。',
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (member.roles.cache.has(role.id)) {
      return interaction.reply({
        content: `✅ すでに認証済みです (${role}).`,
        flags: [MessageFlags.Ephemeral]
      });
    }

    await member.roles.add(role);
    return interaction.reply({
      content: `✅ 認証成功！ ${role} を付与しました。`,
      flags: [MessageFlags.Ephemeral]
    });
  } catch (error) {
    log(`/auth モーダル処理エラー: ${error.message}`, 'error');
    return interaction.reply({
      content: '❌ 認証ロールの付与に失敗しました。',
      flags: [MessageFlags.Ephemeral]
    });
  }
}
