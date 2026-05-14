import { getRolePanelItemByEmoji, getRolePanelSettings } from '../database/rolePanels.js';
import { log } from '../utils/logger.js';

export const name = 'messageReactionAdd';

function getEmojiKey(reaction) {
  if (reaction.emoji?.id) {
    return `${reaction.emoji.name}:${reaction.emoji.id}`;
  }
  return reaction.emoji?.name || null;
}

async function ensureReactionFetched(reaction) {
  if (reaction.partial) {
    await reaction.fetch();
  }
  if (reaction.message?.partial) {
    await reaction.message.fetch();
  }
}

export async function execute(reaction, user) {
  if (!reaction || !user || user.bot) {
    return;
  }

  try {
    await ensureReactionFetched(reaction);

    const guildId = reaction.message?.guildId;
    if (!guildId) {
      return;
    }

    const settings = await getRolePanelSettings(guildId);
    if (!settings.message_id || settings.message_id !== reaction.message.id) {
      return;
    }

    const emojiKey = getEmojiKey(reaction);
    if (!emojiKey) {
      return;
    }

    const item = await getRolePanelItemByEmoji(guildId, emojiKey).catch(() => null);
    if (!item) {
      return;
    }

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      return;
    }

    const role = guild.roles.cache.get(item.role_id);
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!role || !botMember || role.managed || role.position >= botMember.roles.highest.position) {
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role.id).catch(() => null);
    }
  } catch (error) {
    log(`messageReactionAdd エラー: ${error.message}`, 'error');
  }
}
