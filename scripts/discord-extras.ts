/**
 * Sets up:
 * 1. GitHub webhook in #announcements (for release notifications)
 * 2. Welcome screen (if community features are enabled)
 */
import "dotenv/config";

const TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;
const API = "https://discord.com/api/v10";

async function api(path: string, method = "GET", body?: Record<string, unknown>) {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text();
		return { error: true, status: res.status, message: text };
	}
	return res.json();
}

async function main() {
	const channels: { id: string; name: string; type: number }[] = await api(`/guilds/${GUILD_ID}/channels`);

	// ── 1. GitHub webhook in #announcements ──

	const announcements = channels.find((c) => c.name === "announcements");
	if (!announcements) {
		console.error("#announcements not found");
	} else {
		// Check existing webhooks
		const existingWebhooks: { name: string }[] | { error: boolean } = await api(
			`/channels/${announcements.id}/webhooks`,
		);

		const alreadyExists = Array.isArray(existingWebhooks) && existingWebhooks.some((w) => w.name === "GitHub");

		if (alreadyExists) {
			console.log("GitHub webhook already exists in #announcements, skipping");
		} else {
			const webhook = await api(`/channels/${announcements.id}/webhooks`, "POST", {
				name: "GitHub",
			});

			if ("error" in webhook) {
				console.error("Failed to create webhook:", webhook.message);
			} else {
				console.log("Created GitHub webhook in #announcements");
				console.log(`\n  Webhook URL: ${webhook.url}`);
				console.log("\n  To connect GitHub:");
				console.log("  1. Go to your repo → Settings → Webhooks → Add webhook");
				console.log(`  2. Payload URL: ${webhook.url}/github`);
				console.log("  3. Content type: application/json");
				console.log('  4. Events: select "Releases" (and optionally "Stars")\n');
			}
		}
	}

	// ── 2. Welcome screen ──

	const help = channels.find((c) => c.name === "help");
	const general = channels.find((c) => c.name === "general");
	const showcase = channels.find((c) => c.name === "showcase");

	const welcomeChannels = [
		general && {
			channel_id: general.id,
			description: "Chat with the community",
			emoji_name: "👋",
		},
		help && {
			channel_id: help.id,
			description: "Get help with Truman",
			emoji_name: "❓",
		},
		showcase && {
			channel_id: showcase.id,
			description: "Share your roasts and reports",
			emoji_name: "🔥",
		},
	].filter(Boolean);

	const welcomeResult = await api(`/guilds/${GUILD_ID}/welcome-screen`, "PATCH", {
		enabled: true,
		description: "Synthetic users that browse your app, get frustrated, and leave — just like real ones.",
		welcome_channels: welcomeChannels,
	});

	if ("error" in welcomeResult) {
		console.log("Welcome screen requires Community features enabled.");
		console.log('  → Server Settings → "Enable Community" → follow the setup wizard');
		console.log("  Then re-run this script.\n");
	} else {
		console.log("Welcome screen configured!");
	}
}

main();
