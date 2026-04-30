import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { setUserLanguage } from '../database/userSettings.js';
import { getLanguageLabel, resolveUserLanguage, translate } from '../utils/i18n.js';
import { log } from '../utils/logger.js';

const LANGUAGE_CHOICES = [
  { name: '日本語', value: 'ja' },
  { name: 'English', value: 'en' }
];

export const data = new SlashCommandBuilder()
  .setName('language')
  .setDescription('ユーザーごとの表示言語を設定します')
  .addStringOption(option =>
    option
      .setName('lang')
      .setDescription('言語を選択')
      .addChoices(...LANGUAGE_CHOICES)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const selected = interaction.options.getString('lang');
    if (selected) {
      await setUserLanguage(interaction.user.id, selected);
      const label = getLanguageLabel(selected);
      return interaction.editReply(
        translate(selected, 'language.set', { languageLabel: label })
      );
    }

    const lang = await resolveUserLanguage(interaction.user.id);
    const label = getLanguageLabel(lang);
    return interaction.editReply(
      translate(lang, 'language.current', { languageLabel: label })
    );
  } catch (error) {
    log(`/language エラー: ${error.message}`, 'error');
    return interaction.editReply('❌ 設定に失敗しました');
  }
}
