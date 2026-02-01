import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import cron from 'node-cron';
import Database from 'better-sqlite3';

const {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  REPORT_CHANNEL_ID,
  TIMEZONE = 'Europe/Amsterdam',
  REPORT_CRON = '0 9 * * 1',
} = process.env;

// ─── Basic checks ─────────────────────────────────────────────
if (!DISCORD_TOKEN || !LOG_CHANNEL_ID || !REPORT_CHANNEL_ID) {
  console.error('❌ Missing .env values');
  process.exit(1);
}

// ─── Database ─────────────────────────────────────────────────
const db = new Database('violations.sqlite');

db.exec(`
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_tag TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`);

const insertViolation = db.prepare(`
INSERT OR IGNORE INTO violations (guild_tag, user_id, name, message_id, created_at)
VALUES (@guild_tag, @user_id, @name, @message_id, @created_at)
`);

const countThisWeekStmt = db.prepare(`
SELECT COUNT(*) AS cnt
FROM violations
WHERE user_id = ? AND created_at >= ? AND created_at < ?
`);

// ─── Helpers ──────────────────────────────────────────────────
function startOfWeekMs(now = new Date()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}
function endOfWeekMs(now = new Date()) {
  return startOfWeekMs(now) + 7 * 24 * 60 * 60 * 1000;
}

// ─── Parser (jouw format) ─────────────────────────────────────
function parseViolations(text) {
  const lines = text.split('\n');
  const results = [];
  const regex =
    /Player:\s*(.+?)\s*\|\s*UID\s*(\d{6,20})\s*\|\s*([A-Za-z0-9_]+)\s*\|\s*(.+)/i;

  for (const line of lines) {
    const m = regex.exec(line.trim());
    if (!m) continue;

    results.push({
      name: m[1].trim(),
      user_id: m[2].trim(),
      guild_tag: m[3].trim(),
    });
  }
  return results;
}

// ─── Discord client ───────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== LOG_CHANNEL_ID) return;

  const violations = parseViolations(message.content);
  if (!violations.length) return;

  violations.forEach((v, i) => {
    insertViolation.run({
      guild_tag: v.guild_tag,
      user_id: v.user_id,
      name: v.name,
      message_id: `${message.id}-${i}`,
      created_at: Date.now(),
    });

    const { cnt } = countThisWeekStmt.get(
      v.user_id,
      startOfWeekMs(),
      endOfWeekMs()
    );

    if (cnt === 2) {
      client.channels.fetch(REPORT_CHANNEL_ID).then((ch) => {
        ch.send(
          `⚠️ **Second rule break this week** — **${v.name}** (UID: \`${v.user_id}\`) | Guild: **${v.guild_tag}**`
        );
      });
    }
  });

  await message.react('✅');
});

// ─── Weekly report ────────────────────────────────────────────
cron.schedule(
  REPORT_CRON,
  async () => {
    const from = startOfWeekMs();
    const to = endOfWeekMs();

    const rows = db
      .prepare(`
      SELECT guild_tag, user_id, name, COUNT(*) AS cnt
      FROM violations
      WHERE created_at >= ? AND created_at < ?
      GROUP BY guild_tag, user_id, name
      ORDER BY guild_tag, cnt DESC
    `)
      .all(from, to);

    const embed = new EmbedBuilder()
      .setTitle('Weekly Rule Break Report')
      .setTimestamp(new Date());

    if (!rows.length) {
      embed.setDescription('No rule breaks this week 🎉');
    } else {
      const byGuild = {};
      rows.forEach((r) => {
        byGuild[r.guild_tag] ??= [];
        byGuild[r.guild_tag].push(r);
      });

      for (const g in byGuild) {
        embed.addFields({
          name: `Guild: ${g}`,
          value: byGuild[g]
            .map(
              (r) =>
                `• **${r.cnt}x** ${r.name} (UID: \`${r.user_id}\`)`
            )
            .join('\n'),
        });
      }
    }

    const ch = await client.channels.fetch(REPORT_CHANNEL_ID);
    await ch.send({ embeds: [embed] });
  },
  { timezone: TIMEZONE }
);

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN);
