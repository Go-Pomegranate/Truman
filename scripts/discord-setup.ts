/**
 * Discord server setup for Truman community.
 *
 * Usage:
 *   npx tsx scripts/discord-setup.ts
 *
 * Requires DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in .env
 * Bot needs: Manage Channels, Manage Roles permissions + "Server Members Intent" enabled
 */

import "dotenv/config";

const TOKEN = process.env.DISCORD_BOT_TOKEN!;
const GUILD_ID = process.env.DISCORD_GUILD_ID!;

if (!TOKEN || !GUILD_ID) {
	console.error("Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID in .env");
	process.exit(1);
}

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
		throw new Error(`${method} ${path} → ${res.status}: ${text}`);
	}
	return res.json();
}

// Discord channel types
const TEXT = 0;
const VOICE = 2;
const CATEGORY = 4;
const FORUM = 15;

interface Channel {
	id: string;
	name: string;
	type: number;
	parent_id?: string;
}

interface Role {
	id: string;
	name: string;
}

// ── Desired structure ──────────────────────────────────────────────

const ROLES = [
	{ name: "Maintainer", color: 0xe74c3c, hoist: true },
	{ name: "Contributor", color: 0x2ecc71, hoist: true },
	{ name: "Community", color: 0x3498db, hoist: false },
] as const;

interface ChannelDef {
	name: string;
	type: number;
	topic?: string;
	readOnly?: boolean; // only Maintainer can write
}

interface CategoryDef {
	name: string;
	channels: ChannelDef[];
}

const CATEGORIES: CategoryDef[] = [
	{
		name: "Info",
		channels: [
			{
				name: "announcements",
				type: TEXT,
				topic: "Releases, breaking changes, important updates",
				readOnly: true,
			},
			{
				name: "changelog",
				type: TEXT,
				topic: "Automated feed from GitHub releases",
				readOnly: true,
			},
			{
				name: "rules",
				type: TEXT,
				topic: "Community guidelines",
				readOnly: true,
			},
		],
	},
	{
		name: "General",
		channels: [
			{ name: "general", type: TEXT, topic: "General discussion" },
			{ name: "introductions", type: TEXT, topic: "Say hi, tell us what you're building" },
			{
				name: "showcase",
				type: TEXT,
				topic: "Share your Truman roasts, reports, and creative persona configs",
			},
		],
	},
	{
		name: "Support & Dev",
		channels: [
			{
				name: "help",
				type: FORUM,
				topic: "Questions about installation, config, and usage",
			},
			{
				name: "bug-reports",
				type: FORUM,
				topic: "Found a bug? Report it here (or open a GitHub issue)",
			},
			{
				name: "feature-requests",
				type: TEXT,
				topic: "Ideas for new features and improvements",
			},
			{
				name: "contributing",
				type: TEXT,
				topic: "PRs, architecture discussions, how to get started",
			},
		],
	},
	{
		name: "Advanced",
		channels: [
			{
				name: "custom-personas",
				type: TEXT,
				topic: "Share and discuss persona YAML configs",
			},
			{
				name: "integrations",
				type: TEXT,
				topic: "CI/CD, adapters, AI providers, plugins",
			},
		],
	},
	{
		name: "Voice",
		channels: [
			{ name: "Hangout", type: VOICE },
			{ name: "Pair Programming", type: VOICE },
		],
	},
];

// ── Main ───────────────────────────────────────────────────────────

async function main() {
	console.log("Fetching existing server state...\n");

	const [existingChannels, existingRoles] = await Promise.all([
		api(`/guilds/${GUILD_ID}/channels`) as Promise<Channel[]>,
		api(`/guilds/${GUILD_ID}/roles`) as Promise<Role[]>,
	]);

	const channelsByName = new Map(existingChannels.map((c) => [c.name, c]));
	const rolesByName = new Map(existingRoles.map((r) => [r.name, r]));
	const everyoneRole = existingRoles.find((r) => r.name === "@everyone")!;

	// ── Create roles ──

	const roleIds: Record<string, string> = {};

	for (const roleDef of ROLES) {
		if (rolesByName.has(roleDef.name)) {
			console.log(`  Role "${roleDef.name}" already exists, skipping`);
			roleIds[roleDef.name] = rolesByName.get(roleDef.name)?.id;
		} else {
			const role = await api(`/guilds/${GUILD_ID}/roles`, "POST", {
				name: roleDef.name,
				color: roleDef.color,
				hoist: roleDef.hoist,
				mentionable: true,
			});
			roleIds[roleDef.name] = role.id;
			console.log(`  Created role "${roleDef.name}"`);
		}
	}

	const maintainerRoleId = roleIds.Maintainer;

	// ── Create categories & channels ──

	let position = 0;
	for (const cat of CATEGORIES) {
		let category = channelsByName.get(cat.name);

		if (category && category.type === CATEGORY) {
			console.log(`\n  Category "${cat.name}" already exists`);
		} else {
			category = await api(`/guilds/${GUILD_ID}/channels`, "POST", {
				name: cat.name,
				type: CATEGORY,
				position: position++,
			});
			console.log(`\n  Created category "${cat.name}"`);
		}

		for (const ch of cat.channels) {
			const existing = existingChannels.find((c) => c.name === ch.name && c.parent_id === category?.id);

			if (existing) {
				console.log(`    #${ch.name} already exists, skipping`);
				continue;
			}

			// If there's an orphaned channel with same name (e.g. default #general), move it
			const orphan = channelsByName.get(ch.name);

			if (orphan && orphan.type === ch.type) {
				await api(`/channels/${orphan.id}`, "PATCH", {
					parent_id: category?.id,
					topic: ch.topic,
					...(ch.readOnly
						? {
								permission_overwrites: [
									{
										id: everyoneRole.id,
										type: 0,
										deny: "2048", // SEND_MESSAGES
									},
									{
										id: maintainerRoleId,
										type: 0,
										allow: "2048",
									},
								],
							}
						: {}),
				});
				console.log(`    Moved existing #${ch.name} → ${cat.name}`);
				continue;
			}

			const payload: Record<string, unknown> = {
				name: ch.name,
				type: ch.type,
				parent_id: category?.id,
				topic: ch.topic,
			};

			if (ch.readOnly) {
				payload.permission_overwrites = [
					{
						id: everyoneRole.id,
						type: 0,
						deny: "2048",
					},
					{
						id: maintainerRoleId,
						type: 0,
						allow: "2048",
					},
				];
			}

			await api(`/guilds/${GUILD_ID}/channels`, "POST", payload);
			console.log(`    Created #${ch.name} (${ch.type === FORUM ? "forum" : ch.type === VOICE ? "voice" : "text"})`);
		}
	}

	// ── Delete default channels that are now redundant ──

	// Don't auto-delete anything — just inform
	const unmapped = existingChannels.filter(
		(c) => !c.parent_id && c.type === TEXT && !["general", "rules"].includes(c.name),
	);
	if (unmapped.length > 0) {
		console.log("\n  Orphaned channels (consider deleting manually):");
		for (const c of unmapped) {
			console.log(`    - #${c.name} (${c.id})`);
		}
	}

	console.log("\nDone! Server structure is set up.");
}

main().catch((err) => {
	console.error("Setup failed:", err.message);
	process.exit(1);
});
