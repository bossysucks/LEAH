import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { GoogleGenAI } from '@google/genai';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';

const ai = new GoogleGenAI();

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    // THIS IS THE ABSOLUTE FIRST LINE - IT WILL CATCH EVERY MESSAGE
    console.log(`>>> RAW MESSAGE TRIGGERED: "${message.content}" from ${message.author?.tag} in guild ID: ${message.guild?.id}`);

    try {
      if (message.author.bot || !message.guild) return;

      // 1. AI CHAT LISTENER (Triggers if someone tags Leah)
      if (message.mentions.has(client.user)) {
        try {
          await message.channel.sendTyping();

          const prompt = message.content
            .replace(`<@!${client.user.id}>`, '')
            .replace(`<@${client.user.id}>`, '')
            .trim();

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
              systemInstruction: "You are Leah, a sharp, car-obsessed shop manager for LS Spec & Customs. You use car slang, talk about tuning, builds, and shop life, keeping your answers punchy.",
            },
          });

          await message.reply(response.text);
          return;
        } catch (aiError) {
          logger.error('Gemini AI error in messageCreate:', aiError);
          await message.reply("My garage radio's glitching out, try asking me again in a second.").catch(() => {});
          return;
        }
      }

      // 2. Counting Game Handler
      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) {
        return;
      }

      // 3. Prefix Command Handler
      await handlePrefixCommand(message, client);
    } catch (error) {
      console.error("FATAL ERROR IN MESSAGECREATE:", error);
    }
  }
};

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || getCommandPrefix();
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) return;

    let { commandName, args } = parsed;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) {
      commandName = 'music';
      args = [musicPrefixShortcut, ...args];
    }

    const resolvedCommandName = resolveCommandAlias(commandName);
    const command = client.commands.get(resolvedCommandName);
    if (!command) return;

    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => failureMessage.delete().catch(() => {}), 10000);
      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    return false;
  }
}
