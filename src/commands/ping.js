import { SlashCommandBuilder } from 'discord.js';
import { resolveUserLanguage, translate } from '../utils/i18n.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check bot latency');

export async function execute(interaction) {
  const lang = await resolveUserLanguage(interaction.user.id);
  const sentAt = Date.now();
  const wsPing = Math.round(interaction.client.ws.ping);

  await interaction.reply(translate(lang, 'ping.pong', {
    latency: Math.max(0, sentAt - interaction.createdTimestamp),
    ws: Number.isFinite(wsPing) ? wsPing : 'N/A'
  }));
}
