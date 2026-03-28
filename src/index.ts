import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, ThreadAutoArchiveDuration } from 'discord.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARACTERS_PATH = join(__dirname, '../characters.json');
const WEBHOOKS_PATH = join(__dirname, '../webhooks.json');

// Load environment variables
dotenv.config();

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Helper function to find a guild by name or ID
async function findGuild(guildIdentifier?: string) {
  if (!guildIdentifier) {
    // If no guild specified and bot is only in one guild, use that
    if (client.guilds.cache.size === 1) {
      return client.guilds.cache.first()!;
    }
    // List available guilds
    const guildList = Array.from(client.guilds.cache.values())
      .map(g => `"${g.name}"`).join(', ');
    throw new Error(`Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`);
  }

  // Try to fetch by ID first
  try {
    const guild = await client.guilds.fetch(guildIdentifier);
    if (guild) return guild;
  } catch {
    // If ID fetch fails, search by name
    const guilds = client.guilds.cache.filter(
      g => g.name.toLowerCase() === guildIdentifier.toLowerCase()
    );
    
    if (guilds.size === 0) {
      const availableGuilds = Array.from(client.guilds.cache.values())
        .map(g => `"${g.name}"`).join(', ');
      throw new Error(`Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`);
    }
    if (guilds.size > 1) {
      const guildList = guilds.map(g => `${g.name} (ID: ${g.id})`).join(', ');
      throw new Error(`Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`);
    }
    return guilds.first()!;
  }
  throw new Error(`Server "${guildIdentifier}" not found`);
}

// Helper function to find a channel by name or ID within a specific guild
async function findChannel(channelIdentifier: string, guildIdentifier?: string): Promise<TextChannel> {
  const guild = await findGuild(guildIdentifier);
  
  // First try to fetch by ID
  try {
    const channel = await client.channels.fetch(channelIdentifier);
    if (channel instanceof TextChannel && channel.guild.id === guild.id) {
      return channel;
    }
  } catch {
    // If fetching by ID fails, search by name in the specified guild
    const channels = guild.channels.cache.filter(
      (channel): channel is TextChannel =>
        channel instanceof TextChannel &&
        (channel.name.toLowerCase() === channelIdentifier.toLowerCase() ||
         channel.name.toLowerCase() === channelIdentifier.toLowerCase().replace('#', ''))
    );

    if (channels.size === 0) {
      const availableChannels = guild.channels.cache
        .filter((c): c is TextChannel => c instanceof TextChannel)
        .map(c => `"#${c.name}"`).join(', ');
      throw new Error(`Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`);
    }
    if (channels.size > 1) {
      const channelList = channels.map(c => `#${c.name} (${c.id})`).join(', ');
      throw new Error(`Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`);
    }
    return channels.first()!;
  }
  throw new Error(`Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`);
}

// Resolve or create a thread by name in the channel that owns the given webhook URL
async function resolveThreadId(webhookUrl: string, threadName: string): Promise<string> {
  const match = webhookUrl.match(/webhooks\/(\d+)\/([^?]+)/);
  if (!match) throw new Error('Invalid webhook URL format');
  const [, webhookId, webhookToken] = match;

  const webhook = await client.fetchWebhook(webhookId, webhookToken);
  if (!webhook.channelId) throw new Error('Could not determine webhook channel');

  const channel = await client.channels.fetch(webhook.channelId);
  if (!(channel instanceof TextChannel)) throw new Error('Webhook channel is not a text channel');

  // Check active threads
  const active = await channel.threads.fetchActive();
  const activeMatch = active.threads.find(t => t.name.toLowerCase() === threadName.toLowerCase());
  if (activeMatch) return activeMatch.id;

  // Check archived threads
  const archived = await channel.threads.fetchArchived();
  const archivedMatch = archived.threads.find(t => t.name.toLowerCase() === threadName.toLowerCase());
  if (archivedMatch) return archivedMatch.id;

  // Create new thread
  const newThread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });
  return newThread.id;
}

// Updated validation schemas
const SendMessageSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string(),
});

const ReadMessagesSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z.number().min(1).max(100).default(50),
});

const SendWebhookMessageSchema = z.object({
  channel: z.string().optional().describe('Channel name from webhooks.json (e.g. "in-character-role-playing"). Falls back to DISCORD_WEBHOOK_URL env var.'),
  webhook_url: z.string().url().optional().describe('Direct webhook URL override.'),
  thread: z.string().optional().describe('Thread name to post into. Creates the thread if it does not exist.'),
  character: z.string().optional().describe('Character name from characters.json. Auto-fills username and avatar_url.'),
  username: z.string().optional().describe('Display name override when not using a character.'),
  avatar_url: z.string().url().optional().describe('Avatar URL override.'),
  content: z.string().min(1).max(2000).describe('Message content (max 2000 chars).'),
});

let characters: Record<string, { avatar_url: string }> = {};
let webhooks: Record<string, string> = {};

// Create server instance
const server = new Server(
  {
    name: "discord",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            message: {
              type: "string",
              description: "Message content to send",
            },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            limit: {
              type: "number",
              description: "Number of messages to fetch (max 100)",
              default: 50,
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "send-as-character",
        description: "Send a message via Discord webhook as a named character with custom avatar. No bot tag — message appears as the character.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel name from webhooks.json (e.g. \"in-character-role-playing\"). Falls back to DISCORD_WEBHOOK_URL env var.",
            },
            webhook_url: {
              type: "string",
              description: "Direct webhook URL override.",
            },
            thread: {
              type: "string",
              description: "Thread name to post into. Creates the thread if it does not exist.",
            },
            character: {
              type: "string",
              description: "Character name from characters.json. Auto-fills username and avatar_url.",
            },
            username: {
              type: "string",
              description: "Display name override when not using a character.",
            },
            avatar_url: {
              type: "string",
              description: "Avatar URL override.",
            },
            content: {
              type: "string",
              description: "Message content (max 2000 chars).",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "list-characters",
        description: "List all available characters defined in characters.json, including their names. Use this to resolve a partial or informal name to the exact character name before calling send-as-character.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list-characters": {
        try {
          const raw = await readFile(CHARACTERS_PATH, 'utf-8');
          characters = JSON.parse(raw);
        } catch {
          characters = {};
        }
        const names = Object.keys(characters);
        return {
          content: [{
            type: "text",
            text: names.length
              ? `Available characters:\n${names.map(n => `- ${n}`).join('\n')}`
              : "No characters defined in characters.json.",
          }],
        };
      }

      case "send-message": {
        const { channel: channelIdentifier, message } = SendMessageSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const sent = await channel.send(message);
        return {
          content: [{
            type: "text",
            text: `Message sent successfully to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}`,
          }],
        };
      }

      case "read-messages": {
        const { channel: channelIdentifier, limit } = ReadMessagesSchema.parse(args);
        const channel = await findChannel(channelIdentifier);
        
        const messages = await channel.messages.fetch({ limit });
        const formattedMessages = Array.from(messages.values()).map(msg => ({
          channel: `#${channel.name}`,
          server: channel.guild.name,
          author: msg.author.tag,
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(formattedMessages, null, 2),
          }],
        };
      }

      case "send-as-character": {
        const { channel, webhook_url, thread, character, username, avatar_url, content } =
          SendWebhookMessageSchema.parse(args);

        // Reload both configs fresh on every call
        try {
          const raw = await readFile(CHARACTERS_PATH, 'utf-8');
          characters = JSON.parse(raw);
        } catch {
          characters = {};
        }
        try {
          const raw = await readFile(WEBHOOKS_PATH, 'utf-8');
          webhooks = JSON.parse(raw);
        } catch {
          webhooks = {};
        }

        const resolvedWebhookUrl = webhook_url ?? (channel ? webhooks[channel] : undefined) ?? process.env.DISCORD_WEBHOOK_URL;
        if (!resolvedWebhookUrl) {
          const available = Object.keys(webhooks).join(', ');
          throw new Error(`No webhook URL found. Pass webhook_url, set DISCORD_WEBHOOK_URL, or use a channel name from webhooks.json.${available ? ` Available channels: ${available}` : ''}`);
        }

        let resolvedUsername: string | undefined;
        let resolvedAvatarUrl: string | undefined;

        if (character) {
          const charConfig = characters[character];
          resolvedUsername = character;
          resolvedAvatarUrl = charConfig?.avatar_url ?? avatar_url;
        } else {
          resolvedUsername = username;
          resolvedAvatarUrl = avatar_url;
        }

        const payload: Record<string, string> = { content };
        if (resolvedUsername) payload.username = resolvedUsername;
        if (resolvedAvatarUrl) payload.avatar_url = resolvedAvatarUrl;

        // Resolve thread: find existing or create new, then append thread_id to URL
        let finalWebhookUrl = resolvedWebhookUrl;
        if (thread) {
          const threadId = await resolveThreadId(resolvedWebhookUrl, thread);
          finalWebhookUrl = `${resolvedWebhookUrl}?thread_id=${threadId}`;
        }

        const response = await fetch(finalWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Webhook failed: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        return {
          content: [{
            type: 'text',
            text: `Webhook message sent as "${resolvedUsername ?? 'webhook'}"`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`
      );
    }
    throw error;
  }
});

// Discord client login and error handling
client.once('ready', () => {
  console.error('Discord bot is ready!');
});

// Start the server
async function main() {
  // Check for Discord token
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
  }
  
  try {
    // Login to Discord
    await client.login(token);

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Discord MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main();