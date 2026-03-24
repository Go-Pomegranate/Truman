import "dotenv/config";

const TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;

const API = "https://discord.com/api/v10";

async function main() {
  // Get bot's own user ID
  const meRes = await fetch(`${API}/users/@me`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  const me: { id: string } = await meRes.json();

  const res = await fetch(`${API}/guilds/${GUILD_ID}/channels`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  const channels: { id: string; name: string }[] = await res.json();
  const rules = channels.find((c) => c.name === "rules");

  if (!rules) {
    console.error("Channel #rules not found");
    process.exit(1);
  }

  // Temporarily allow the bot to send messages in #rules
  await fetch(`${API}/channels/${rules.id}/permissions/${me.id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: me.id,
      type: 1, // member
      allow: "2048", // SEND_MESSAGES
    }),
  });

  const message = `# Server Rules

**1. Be respectful.** Treat everyone with kindness. No harassment, hate speech, or personal attacks.

**2. Stay on topic.** This server is about Truman and UX/app testing. Off-topic stuff goes to #general.

**3. No spam or self-promotion.** Don't drop random links. Sharing your project in #showcase is fine if it uses Truman.

**4. Search before asking.** Check #help forum threads before posting a new question — it might already be answered.

**5. Bugs go to the right place.** Use #bug-reports or GitHub Issues — not #general.

**6. English please.** Keep discussions in English so everyone can follow.

**7. No leaked keys or tokens.** Don't paste API keys, bot tokens, or credentials. If you do, rotate them immediately.

**8. Be patient with contributors.** This is an open-source project maintained by volunteers. PRs and issues get reviewed when they get reviewed.

**9. Have fun roasting apps, not people.**`;

  const postRes = await fetch(`${API}/channels/${rules.id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message }),
  });

  if (!postRes.ok) {
    const text = await postRes.text();
    console.error(`Failed to post: ${postRes.status} ${text}`);
    process.exit(1);
  }

  // Remove the temporary bot permission override
  await fetch(`${API}/channels/${rules.id}/permissions/${me.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bot ${TOKEN}` },
  });

  console.log("Rules posted to #rules!");
}

main();
