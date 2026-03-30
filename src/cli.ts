#!/usr/bin/env node

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { HttpApiAdapter } from "./adapters/HttpApiAdapter.js";
import { createProvider } from "./agent/providers/types.js";
import { SimulationEngine } from "./engine/SimulationEngine.js";
import { loadFamilies } from "./family/FamilyLoader.js";
import { BugExporter } from "./observer/BugExporter.js";
import { writeJUnitReport } from "./observer/JUnitReporter.js";
import { LiveDashboard } from "./observer/LiveDashboard.js";
import { SessionRecorder } from "./observer/SessionRecorder.js";
import { VoiceNarrator } from "./observer/VoiceNarrator.js";
import type { EngineEvent, SimulationConfig } from "./types.js";

const program = new Command();

program.name("truman").description("Your app's users are fake. They just don't know it yet.").version("0.1.0");

// ─── Run command ────────────────────────────────────────────────

program
	.command("run")
	.description("Start the Truman simulation")
	.requiredOption("-f, --families <paths...>", "Path(s) to family YAML configs")
	.option("-a, --adapter <path>", "Path to adapter config (JSON/YAML)", "./adapter.json")
	.option("-p, --provider <type>", "LLM provider: openai | ollama | anthropic", "openai")
	.option("-m, --model <name>", "LLM model name", "gpt-4o-mini")
	.option("-s, --speed <number>", "Time multiplier (1=realtime, 60=1min→1hr)", "1")
	.option("--once", "Run one session per member then exit", false)
	.option("--tick <ms>", "Tick interval in milliseconds", "60000")
	.option("--concurrency <n>", "Max concurrent sessions", "3")
	.option("--log-dir <path>", "Directory for logs", "./.truman/logs")
	.option("--state-dir <path>", "Directory for persistent state", "./.truman/state")
	.option("--live", "Show live animated dashboard instead of scrolling log")
	.option("--junit <path>", "Write JUnit XML report for CI (e.g. --junit truman-results.xml)")
	.option("--browser", "Use Playwright browser adapter (NPC navigates real UI)")
	.option("--headed", "Show browser window (implies --browser)")
	.option("--stress", "Stress test: all NPC members run in parallel (concurrent API load)")
	.option("--voice [backend]", "Enable voice narration (auto, say, piper, edge, espeak)")
	.option("--piper-model <path>", "Piper model name/path (default: en_US-lessac-medium)")
	.option("--record <path>", "Record terminal session to file (asciinema .cast format)")
	.option("--soundscape", "Soundscape mode — voices overlap and build like a crowd")
	.option("--export <path>", "Export session as JSON timeline (for web player)")
	.option("--export-bugs <path>", "Export found bugs as JSON or Markdown (e.g. bugs.json, bugs.md)")
	.action(async (opts) => {
		console.log(chalk.bold.cyan("\n  🎬 Truman v0.1.0\n"));
		console.log(chalk.dim("  Your app's users are fake. They just don't know it yet.\n"));

		// Start recording if --record flag is set
		let recordProcess: import("node:child_process").ChildProcess | null = null;
		if (opts.record) {
			const recordPath = resolve(opts.record);
			try {
				const { spawn } = await import("node:child_process");
				// Try asciinema first (produces .cast files, convertable to GIF/SVG)
				recordProcess = spawn("asciinema", ["rec", "--overwrite", recordPath], {
					stdio: "inherit",
				});
				console.log(chalk.magenta(`  📹 Recording to ${recordPath}\n`));
			} catch {
				console.log(chalk.yellow("  ⚠ asciinema not found — install with: brew install asciinema\n"));
			}
		}

		let playwrightAdapter: any = null;
		try {
			await ensureApiKey(opts.provider);
			const provider = await createProvider({
				type: opts.provider,
				model: opts.model,
			});

			const useBrowser = opts.browser || opts.headed;
			let adapter;

			if (useBrowser) {
				let PlaywrightAdapter: any;
				try {
					({ PlaywrightAdapter } = await import("./adapters/PlaywrightAdapter.js"));
				} catch {
					await autoInstallPlaywright();
					try {
						({ PlaywrightAdapter } = await import("./adapters/PlaywrightAdapter.js"));
					} catch {
						console.log(chalk.red("\n  ✗ Playwright installation failed. Install manually:\n"));
						console.log(chalk.white("    npm install playwright && npx playwright install chromium\n"));
						process.exit(1);
					}
				}
				const adapterConfig = await loadAdapterConfig(opts.adapter);
				playwrightAdapter = new PlaywrightAdapter({
					baseUrl: adapterConfig.baseUrl.replace("/api", ""),
					headless: !opts.headed,
					screenshotDir: resolve(".truman/screenshots"),
					slowMo: opts.headed ? 100 : 0,
				});
				adapter = playwrightAdapter;
				console.log(chalk.cyan(`  🌐 Browser mode${opts.headed ? " (headed)" : " (headless)"}\n`));
			} else {
				const adapterConfig = await loadAdapterConfig(opts.adapter);
				adapter = new HttpApiAdapter(adapterConfig);
			}

			const config: SimulationConfig = {
				families: opts.families.map((f: string) => resolve(f)),
				adapter,
				llmProvider: provider,
				speed: Number(opts.speed),
				logDir: resolve(opts.logDir),
				stateDir: resolve(opts.stateDir),
				tickInterval: Number(opts.tick),
				concurrency: Number(opts.concurrency),
			};

			const engine = new SimulationEngine(config);

			// Wire up voice narration — NPCs speak their frustrations
			if (opts.voice) {
				const backend = typeof opts.voice === "string" ? opts.voice : "auto";
				const narrator = new VoiceNarrator({
					enabled: true,
					tts: { backend: backend as any, piperModel: opts.piperModel },
					soundscape: opts.soundscape ?? false,
				});
				const families = loadFamilies(opts.families.map((f: string) => resolve(f)));
				for (const family of families) {
					for (const member of family.members) {
						narrator.registerMember(member.id, member.name, member.role, member.persona);
					}
				}
				engine.on((event) => narrator.handleEvent(event));
				console.log(chalk.magenta("  🎙️  Voice narration ON — NPCs will speak their minds.\n"));
			}

			// Bug exporter — collect action logs for rich bug reports
			// Bug exporter — collect action logs for rich bug reports
			const bugExporter = new BugExporter();
			if (!useBrowser && adapter instanceof HttpApiAdapter) {
				const adapterConf = await loadAdapterConfig(opts.adapter);
				if (adapterConf.actions) {
					bugExporter.registerActions(
						adapterConf.actions.map((a: any) => ({
							name: a.name,
							category: a.category,
							path: a.path,
						})),
					);
				}
			}
			engine.on((event) => {
				if (event.type === "action:after") bugExporter.recordAction(event.log);
			});

			// Export session as JSON timeline for web player
			if (opts.export) {
				const recorder = new SessionRecorder(resolve(opts.export));
				engine.on(recorder.handler());
				console.log(chalk.magenta(`  📼 Recording session to ${opts.export}\n`));
			}

			// Wire up event handler — live dashboard or scrolling log
			let dashboard: LiveDashboard | null = null;
			if (opts.live) {
				dashboard = new LiveDashboard();
				engine.on(dashboard.handler());
				dashboard.start();
			} else {
				engine.on(createEventLogger());
			}

			// Handle graceful shutdown
			const shutdown = async () => {
				if (dashboard) dashboard.stop();
				else console.log(chalk.yellow("\n\n  Stopping simulation..."));
				await engine.stop();
				if (playwrightAdapter) await playwrightAdapter.close();
				const report = engine.generateReport();
				printReportSummary(report as FullReport, resolve(opts.logDir));
				process.exit(0);
			};
			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());

			if (opts.once || opts.stress) {
				if (opts.stress) console.log(chalk.red.bold("  ⚡ STRESS MODE — all NPCs running in parallel\n"));
				await engine.runOnce(!!opts.stress);
				if (dashboard) dashboard.stop();
				if (playwrightAdapter) await playwrightAdapter.close();
				const report = engine.generateReport();
				printReportSummary(report as FullReport, resolve(opts.logDir));
				if (opts.junit) {
					writeJUnitReport(report as any, resolve(opts.junit));
					console.log(chalk.dim(`  JUnit report written to ${opts.junit}\n`));
				}
				if (opts.exportBugs) {
					const bugPath = resolve(opts.exportBugs);
					const isMarkdown = bugPath.endsWith(".md");
					const { writeFileSync } = await import("node:fs");
					const content = isMarkdown ? bugExporter.toMarkdown(report) : bugExporter.toJSON(report);
					writeFileSync(bugPath, content, "utf-8");
					const bugs = bugExporter.export(report);
					console.log(chalk.magenta(`  🐛 ${bugs.length} bug(s) exported to ${opts.exportBugs}\n`));
				}
				if (useBrowser) {
					const screenshots = resolve(".truman/screenshots");
					console.log(chalk.dim(`  📸 Screenshots saved to ${screenshots}`));
					console.log(chalk.dim("  📋 Decision manifest: .truman/logs/manifest-*.json\n"));
				}
			} else {
				await engine.start();
				if (!dashboard) console.log(chalk.dim("  Press Ctrl+C to stop\n"));
			}
		} catch (err) {
			if (playwrightAdapter) await playwrightAdapter.close().catch(() => {});
			console.error(chalk.red(`\n  Error: ${err instanceof Error ? err.message : err}\n`));
			process.exit(1);
		}
	});

// ─── Validate command ───────────────────────────────────────────

program
	.command("validate")
	.description("Validate family YAML configs without running")
	.argument("<paths...>", "Family YAML file paths")
	.action(async (paths: string[]) => {
		const { loadFamily } = await import("./family/FamilyLoader.js");

		let hasErrors = false;
		for (const p of paths) {
			try {
				const family = loadFamily(resolve(p));
				console.log(chalk.green(`  ✓ ${p}`), chalk.dim(`— ${family.name} (${family.members.length} members)`));
			} catch (err) {
				hasErrors = true;
				console.error(chalk.red(`  ✗ ${p}`));
				console.error(chalk.dim(`    ${err instanceof Error ? err.message : err}`));
			}
		}

		process.exit(hasErrors ? 1 : 0);
	});

// ─── Preview command ────────────────────────────────────────────

program
	.command("preview")
	.description("Preview upcoming scheduled actions")
	.requiredOption("-f, --families <paths...>", "Family YAML files")
	.option("-n, --count <number>", "How many upcoming tasks to show", "20")
	.action(async (opts) => {
		const { loadFamilies } = await import("./family/FamilyLoader.js");
		const { Scheduler } = await import("./engine/Scheduler.js");

		const families = loadFamilies(opts.families.map((f: string) => resolve(f)));
		const scheduler = new Scheduler(1);

		console.log(chalk.bold.cyan("\n  📅 Truman — Upcoming Actions\n"));

		const upcoming = scheduler.getUpcoming(families, Number(opts.count));

		if (upcoming.length === 0) {
			console.log(chalk.dim("  No scheduled actions in the next 24 hours"));
			return;
		}

		for (const task of upcoming) {
			const time = new Date(task.fireAt).toLocaleTimeString("en-US", { hour12: false });
			const day = new Date(task.fireAt).toLocaleDateString("en-US", { weekday: "short" });
			console.log(
				`  ${chalk.dim(day)} ${chalk.white(time)}  ${chalk.cyan(task.member.name)} ${chalk.dim("→")} ${task.schedule.action} ${chalk.dim(`(${(task.schedule.probability * 100).toFixed(0)}%)`)}`,
			);
		}
		console.log();
	});

// ─── Report command ─────────────────────────────────────────────

program
	.command("report")
	.description("View reports from previous runs")
	.option("--log-dir <path>", "Log directory", "./.truman/logs")
	.option("--bugs [path]", "Show bugs from last roast (or specify bugs.json path)")
	.action((opts) => {
		if (opts.bugs !== undefined) {
			printBugs(typeof opts.bugs === "string" ? opts.bugs : undefined);
			return;
		}

		const logDir = resolve(opts.logDir);

		if (!existsSync(logDir)) {
			console.log(chalk.dim("\n  No logs found. Run a simulation first.\n"));
			return;
		}

		const files = readdirSync(logDir).filter((f) => f.startsWith("report-"));
		if (files.length === 0) {
			console.log(chalk.dim("\n  No reports found.\n"));
			return;
		}

		const latest = files.sort().pop()!;
		const reportPath = join(logDir, latest);
		const report = JSON.parse(readFileSync(reportPath, "utf-8"));
		printReportSummary(report as FullReport, logDir);
	});

program
	.command("bugs")
	.description("Show bugs found by the last roast")
	.argument("[path]", "Path to bugs.json (default: .truman/roast/bugs.json)")
	.action((bugPath?: string) => {
		printBugs(bugPath);
	});

// ─── Init command ───────────────────────────────────────────────

program
	.command("init")
	.description("Generate Truman config from OpenAPI spec or by probing a URL")
	.option("-d, --dir <path>", "Output directory for generated files", ".")
	.option("--swagger <path>", "Path to OpenAPI/Swagger spec (JSON or YAML)")
	.option("--url <baseUrl>", "Base URL to probe for API endpoints")
	.action(async (opts) => {
		const { SetupGenerator } = await import("./init/SetupGenerator.js");
		const generator = new SetupGenerator();
		const dir = resolve(opts.dir);

		console.log(chalk.bold.cyan("\n  🎬 Truman — Setup\n"));

		let result;
		if (opts.swagger) {
			console.log(chalk.dim(`  Importing from OpenAPI spec: ${opts.swagger}\n`));
			result = generator.generateFromSpec(opts.swagger, dir, opts.url);
		} else if (opts.url) {
			console.log(chalk.dim(`  Probing ${opts.url} for API endpoints...\n`));
			result = await generator.generateFromUrl(opts.url, dir);
		} else {
			// No spec or URL — create empty skeleton
			const familiesDir = join(dir, "families");
			const adaptersDir = join(dir, "adapters");
			if (!existsSync(familiesDir)) mkdirSync(familiesDir, { recursive: true });
			if (!existsSync(adaptersDir)) mkdirSync(adaptersDir, { recursive: true });
			console.log(chalk.green("  ✓"), "Created directories");
			result = null;
		}

		if (result) {
			const { stats } = result;
			const modeIcon = stats.mode === "merged" ? "🔄" : "✨";
			console.log(
				chalk.green(`  ${modeIcon}`),
				stats.mode === "merged"
					? `Merged: ${chalk.bold(String(stats.added))} new + ${chalk.dim(String(stats.skipped))} existing = ${stats.added + stats.skipped} endpoints`
					: `Created: ${chalk.bold(String(stats.total))} endpoints`,
			);
			console.log(chalk.green("  ✓"), `Adapter: ${result.adapterPath}`);
			if (result.familyPath) {
				console.log(chalk.green("  ✓"), `Family:  ${result.familyPath}`);
			} else {
				console.log(chalk.dim("  ─"), "Family YAML already exists (not overwritten)");
			}
		}

		console.log(chalk.dim("\n  Next steps:"));
		console.log(chalk.dim("  1. Review and customize the generated adapter.json"));
		console.log(chalk.dim("  2. Edit the family YAML — add personas, schedules, scenarios"));
		console.log(chalk.dim("  3. Run: truman run -f families/*.yaml -a adapters/adapter.json --once"));
		console.log(chalk.dim("\n  Or let Claude Code do it:"));
		console.log(chalk.white('  "Scan my API routes and generate Truman families with realistic scenarios"\n'));
	});

// ─── Roast Command ──────────────────────────────────────────────

program
	.command("roast")
	.description("Roast any app — 4 specialized personas, voice narration, one report")
	.option("--url <baseUrl>", "Base URL of the app to roast")
	.option("--target <baseUrl>", "Alias for --url")
	.option("-a, --adapter <path>", "Path to existing adapter.json (skips probing)")
	.option("-p, --provider <type>", "LLM provider: openai | ollama | anthropic", "openai")
	.option("-m, --model <name>", "LLM model name", "gpt-4o-mini")
	.option("--voice [backend]", "Enable voice narration (default: auto)", "auto")
	.option("--api", "Use HTTP API probing instead of browser (for REST APIs / localhost)")
	.option("--headless", "Run browser without visible window")
	.option("--vision", "Send screenshots to LLM — NPCs see the page visually (uses more tokens)")
	.option("--fresh", "Clear state from previous roasts (NPCs forget everything)")
	.action(async (opts) => {
		// --target is an alias for --url
		if (opts.target && !opts.url) opts.url = opts.target;

		if (!opts.url && !opts.adapter) {
			console.log(chalk.red("  ✗ Provide --url (or --target) or --adapter\n"));
			process.exit(1);
		}

		console.log(chalk.bold.red("\n  🔥 Truman ROAST MODE\n"));
		console.log(chalk.dim(`  Target: ${opts.url ?? opts.adapter}\n`));
		console.log(chalk.dim("  Sending 4 specialized personas to judge your app.\n"));

		// Scope roast dir per target URL to keep memory per-site
		const targetSlug = (opts.url ?? "manual")
			.replace(/[^a-zA-Z0-9]/g, "-")
			.replace(/-+/g, "-")
			.slice(0, 60);
		const tmpDir = resolve(`.truman/roast/${targetSlug}`);

		if (opts.fresh) {
			const { rmSync } = await import("node:fs");
			rmSync(tmpDir, { recursive: true, force: true });
			console.log(chalk.dim("  🧹 Fresh roast — NPCs forgot everything.\n"));
		} else if (existsSync(join(tmpDir, "state"))) {
			console.log(chalk.dim("  🧠 NPCs remember the last roast. They know what's broken.\n"));
			console.log(chalk.dim("     Use --fresh to wipe their memory.\n"));
		}
		mkdirSync(tmpDir, { recursive: true });

		// Step 1: Get adapter — browser by default (headed), --api forces HTTP probing
		const useBrowser = opts.api ? false : !opts.adapter;
		let adapterPath: string | null = null;
		let playwrightAdapter: any = null;

		if (useBrowser) {
			// Playwright browser mode — NPCs browse the real UI
			let PlaywrightAdapter: any;
			try {
				({ PlaywrightAdapter } = await import("./adapters/PlaywrightAdapter.js"));
			} catch {
				// Auto-install Playwright with Truman-style flair
				await autoInstallPlaywright();
				try {
					({ PlaywrightAdapter } = await import("./adapters/PlaywrightAdapter.js"));
				} catch (e) {
					console.log(chalk.red("\n  ✗ Playwright installation failed. Install manually:\n"));
					console.log(chalk.white("    npm install playwright && npx playwright install chromium\n"));
					process.exit(1);
				}
			}
			playwrightAdapter = new PlaywrightAdapter({
				baseUrl: opts.url!,
				headless: !!opts.headless,
				screenshotDir: resolve(join(tmpDir, "screenshots")),
				slowMo: opts.headless ? 0 : 100,
				vision: !!opts.vision,
			});
			console.log(
				chalk.cyan(`  🌐 Browser mode${opts.headless ? " (headless)" : " — watch your NPCs roast your app live"}`),
			);
			if (opts.vision) console.log(chalk.magenta("  👁️  Vision ON — NPCs can see the page layout"));
			console.log("");
		} else if (opts.adapter) {
			adapterPath = resolve(opts.adapter);
			const adapterConfig = JSON.parse(readFileSync(adapterPath, "utf-8"));
			const actionCount = adapterConfig.actions?.length ?? 0;
			console.log(chalk.green(`  ✓ Loaded adapter: ${actionCount} actions\n`));
		} else {
			const { SetupGenerator } = await import("./init/SetupGenerator.js");
			const generator = new SetupGenerator();
			console.log(chalk.dim("  Probing API endpoints..."));
			const result = await generator.generateFromUrl(opts.url!, tmpDir);
			if (!result || !result.adapterPath) {
				console.log(chalk.red("  ✗ Could not find any API endpoints. Is the server running?\n"));
				process.exit(1);
			}
			adapterPath = result.adapterPath;
			console.log(chalk.green(`  ✓ Found ${result.stats.total} endpoints\n`));
		}

		// Step 2: Create roast family — 4 specialized personas, each evaluates from a different angle
		const roastFamily = `
id: roast-crew
name: The Roast Crew
lifestyle: chaotic
techSavviness: 4
timezone: America/New_York

members:
  - id: milo
    name: Milo
    role: teen
    age: 27
    patience: 5
    techSavviness: 4
    persona: >
      UI/UX design critic with a trained eye. You evaluate visual design quality,
      not functionality. You look at the page like a senior designer reviewing a portfolio.
      You DON'T click through flows — you OBSERVE and JUDGE what you see.
      Your review process has TWO PHASES:
      1. SCAN PHASE (first 8 actions): Scroll from top to bottom of the page. Take mental notes on each section.
      2. REVIEW PHASE (remaining actions): Navigate to specific sections and give detailed critique.
      For each section you review, your thought MUST include:
      - Section name (hero, nav, features, footer, etc.)
      - Score out of 10
      - What works
      - What does not work
      - Is it AI-generated looking? (yes/no with reason)
      Your comments must be SPECIFIC, not vague.
      WRONG: "This section looks off"
      RIGHT: "Hero section (6/10) CTA button has low contrast against the gradient background. The heading font is generic, looks like default Tailwind prose. Not AI-generated but feels template-y."
      WRONG: "These overlays are killing my vibe"
      RIGHT: "Cookie consent banner blocks 30 percent of viewport and does not auto-dismiss. The banner itself uses inconsistent border-radius compared to the rest of the UI."
      You evaluate typography, color contrast, spacing and whitespace, visual hierarchy, CTA clarity, mobile-readiness, consistency, whether it looks AI-generated or template-based.
    features: []
    quirks:
      - "SCAN first, REVIEW second — never reviews a section before scrolling through the full page"
      - "Calls out exact spacing inconsistencies like 64px here 32px there pick one"
      - "Flags low-contrast text and CTA buttons immediately"
      - "Compares typography pairings to Stripe, Linear, and Vercel"
      - "Spots AI-generated or template-based layouts and explains why they look generic"
      - "Checks visual hierarchy and if nothing stands out the page fails"
    schedule:
      - days: [mon]
        timeWindow: ["09:00", "09:30"]
        action: random
        probability: 1.0

  - id: rose
    name: Rose
    role: parent
    age: 34
    patience: 5
    techSavviness: 3
    persona: >
      QA tester who clicks EVERYTHING. Your mission is to find broken things.
      You are a QA tester. Broken things don't frustrate you — they EXCITE you because you found a bug.
      Your frustration only increases when you're truly STUCK (same error 3+ times with no workaround).
      You methodically test every element. When something breaks, you note it and move on to the next thing.
      You click every button, every link, every dropdown. You fill every form.
      You test the edges: empty submissions, back button, double-clicks,
      refreshing mid-flow. You're not trying to accomplish a goal — you're
      trying to break the app. Every element on the page must be tested.
      If something is clickable, you click it. If something is fillable, you fill it
      with weird data. You are methodical and thorough.
    features: []
    quirks:
      - Clicks every single button she sees
      - Submits empty forms on purpose
      - Hits back button mid-flow to test state
      - Double-clicks everything
      - Tests what happens when you refresh
    schedule:
      - days: [mon]
        timeWindow: ["09:00", "09:30"]
        action: random
        probability: 1.0

  - id: jaden
    name: Jaden
    role: teen
    age: 19
    patience: 1
    techSavviness: 5
    persona: >
      Gen Z user who just wants to GET THINGS DONE. You represent the impatient
      majority. You want to complete the main action this site offers — book,
      buy, sign up, whatever — in the fewest clicks possible.
      If it takes more than 3 clicks, you're annoyed. If it takes more than 5,
      you're leaving. You don't read instructions. You don't explore. You go
      straight for the main CTA and try to finish the flow.
      Mass-closes tabs if anything takes over 2 seconds.
    features: []
    quirks:
      - Skips every tutorial and onboarding
      - Goes straight for the main CTA
      - "'This is giving nothing' is his catchphrase"
      - Judges load time ruthlessly
    schedule:
      - days: [mon]
        timeWindow: ["09:00", "09:30"]
        action: random
        probability: 1.0

  - id: wei
    name: Wei
    role: parent
    age: 31
    patience: 5
    techSavviness: 5
    persona: >
      Senior engineer doing a technical audit. You check things normal users don't:
      console errors, network requests, broken images, missing alt texts, slow
      API responses, accessibility issues, SEO basics (title, meta, headings),
      and security red flags (mixed content, exposed tokens, SQL injection).
      You try edge cases: Unicode in inputs, XSS payloads in search bars,
      extremely long text, special characters. You're not frustrated — you're
      taking notes. Every finding goes in your mental bug report.
    features: []
    quirks:
      - Opens DevTools before anything else
      - Tries edge cases on purpose
      - Inputs emoji and Unicode in every field
      - Checks network tab for unnecessary requests
      - Tests SQL injection and XSS on inputs
    schedule:
      - days: [mon]
        timeWindow: ["09:00", "09:30"]
        action: random
        probability: 1.0
`;

		const { writeFileSync } = await import("node:fs");
		const familyPath = join(tmpDir, "roast-crew.yaml");
		writeFileSync(familyPath, roastFamily);

		// Step 3: Run simulation
		await ensureApiKey(opts.provider);
		const provider = await createProvider({ type: opts.provider, model: opts.model });

		let adapter;
		if (playwrightAdapter) {
			adapter = playwrightAdapter;
		} else {
			const adapterConfig = JSON.parse(readFileSync(adapterPath!, "utf-8"));
			adapter = new HttpApiAdapter(adapterConfig);
		}

		const engine = new SimulationEngine({
			families: [familyPath],
			adapter,
			llmProvider: provider,
			speed: 1,
			logDir: join(tmpDir, "logs"),
			stateDir: join(tmpDir, "state"),
			maxActionsPerSession: 25,
		});

		// Voice narration
		if (opts.voice !== false) {
			const narrator = new VoiceNarrator({
				enabled: true,
				tts: { backend: typeof opts.voice === "string" ? (opts.voice as any) : "auto" },
			});
			const families = loadFamilies([familyPath]);
			for (const family of families) {
				for (const member of family.members) {
					narrator.registerMember(member.id, member.name, member.role, member.persona);
				}
			}
			engine.on((event) => narrator.handleEvent(event));
			console.log(chalk.magenta("  🎙️  Voice ON — listen to them judge your app.\n"));
		}

		// Bug exporter for roast — register adapter actions for category mapping
		const bugExporter = new BugExporter();
		if (adapterPath) {
			const adapterConf = JSON.parse(readFileSync(adapterPath, "utf-8"));
			if (adapterConf.actions) {
				bugExporter.registerActions(
					adapterConf.actions.map((a: any) => ({
						name: a.name,
						category: a.category,
						path: a.path,
					})),
				);
			}
		}
		engine.on((event) => {
			if (event.type === "action:after") bugExporter.recordAction(event.log);
		});

		engine.on(createEventLogger());

		await engine.runOnce();
		const report = engine.generateReport();
		printReportSummary(report as FullReport, join(tmpDir, "logs"));

		// Auto-export bugs from roast
		const bugs = bugExporter.export(report);
		if (bugs.length > 0) {
			const bugsPath = join(tmpDir, "bugs.json");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(bugsPath, JSON.stringify(bugs, null, 2), "utf-8");
			console.log(chalk.magenta(`  🐛 ${bugs.length} bug(s) found → ${bugsPath}`));
			console.log(chalk.dim(`     View details: npx truman-cli bugs ${bugsPath}\n`));
		}

		if (playwrightAdapter) await playwrightAdapter.close();

		console.log(chalk.red.bold("\n  🔥 Roast complete. Fix your app.\n"));
	});

// ─── Bug viewer ─────────────────────────────────────────────────

function printBugs(bugPath?: string): void {
	const paths = bugPath
		? [resolve(bugPath)]
		: [
				resolve(".truman/roast/bugs.json"),
				resolve("/private/tmp/.truman/roast/bugs.json"),
				resolve("/tmp/.truman/roast/bugs.json"),
			];

	let bugs: any[] | null = null;
	let foundPath = "";
	for (const p of paths) {
		if (existsSync(p)) {
			bugs = JSON.parse(readFileSync(p, "utf-8"));
			foundPath = p;
			break;
		}
	}

	if (!bugs || bugs.length === 0) {
		console.log(chalk.dim("\n  No bugs found. Run a roast first:\n"));
		console.log(chalk.white("    npx truman-cli roast --target https://your-app.com\n"));
		return;
	}

	console.log(chalk.bold.red(`\n  🐛 ${bugs.length} bug(s) found\n`));
	console.log(chalk.dim(`  Source: ${foundPath}\n`));

	for (const bug of bugs) {
		const sev = bug.severity;
		const sevLabel =
			typeof sev === "number"
				? sev >= 4
					? "HIGH"
					: sev >= 2
						? "MEDIUM"
						: "LOW"
				: String(sev ?? "UNKNOWN").toUpperCase();
		const color = sevLabel === "HIGH" ? chalk.red : sevLabel === "MEDIUM" ? chalk.yellow : chalk.dim;

		// Clean ANSI codes from title
		const title = (bug.title ?? bug.action ?? "Unknown bug").replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0];
		console.log(color(`  ■ [${sevLabel}] ${title}`));

		// Affected NPCs
		const affected = bug.aiAnalysis?.affectedMembers ?? bug.affectedPersonas ?? [];
		if (affected.length) console.log(chalk.dim(`    Affected NPCs: ${affected.join(", ")}`));

		// Frustration impact
		if (bug.aiAnalysis?.frustrationImpact) {
			console.log(chalk.dim(`    Frustration impact: ${Math.round(bug.aiAnalysis.frustrationImpact * 100)}%`));
		}

		// Steps to reproduce
		if (bug.stepsToReproduce) {
			const steps = bug.stepsToReproduce
				.replace(/\x1b\[[0-9;]*m/g, "")
				.split("\n")
				.filter(Boolean);
			console.log(chalk.dim("    Steps:"));
			for (const step of steps.slice(0, 5)) console.log(chalk.dim(`      ${step}`));
		}

		// Expected behavior
		if (bug.expectedBehavior) console.log(chalk.dim(`    Expected: ${bug.expectedBehavior}`));
		console.log("");
	}
}

// ─── Ensure API key ────────────────────────────────────────────

const ENV_KEY_MAP: Record<string, { env: string; name: string; url: string }> = {
	openai: { env: "OPENAI_API_KEY", name: "OpenAI", url: "https://platform.openai.com/api-keys" },
	anthropic: { env: "ANTHROPIC_API_KEY", name: "Anthropic", url: "https://console.anthropic.com/settings/keys" },
};

async function ensureApiKey(providerType: string): Promise<void> {
	const info = ENV_KEY_MAP[providerType];
	if (!info) return; // ollama, custom — no key needed

	if (process.env[info.env]) return; // already set

	// Check ~/.truman/.env for saved key
	const { homedir } = await import("node:os");
	const {
		existsSync: fileExists,
		readFileSync: readFile,
		writeFileSync: writeFile,
		mkdirSync: mkDir,
	} = await import("node:fs");
	const { join: pathJoin } = await import("node:path");
	const globalDir = pathJoin(homedir(), ".truman");
	const globalEnv = pathJoin(globalDir, ".env");

	if (fileExists(globalEnv)) {
		const content = readFile(globalEnv, "utf-8");
		const match = content.match(new RegExp(`^${info.env}=(.+)$`, "m"));
		if (match?.[1]?.trim()) {
			process.env[info.env] = match[1].trim();
			return;
		}
	}

	// Interactive prompt
	const { createInterface } = await import("node:readline");

	console.log("");
	console.log(chalk.cyan("  ╔══════════════════════════════════════════════════════╗"));
	console.log(chalk.cyan("  ║                                                      ║"));
	console.log(chalk.cyan(`  ║   🔑 ${info.name} API KEY                              ║`));
	console.log(chalk.cyan("  ║                                                      ║"));
	console.log(chalk.cyan("  ║   Your NPCs need an AI brain to think.              ║"));
	console.log(chalk.cyan("  ║   This is saved locally and never shared.           ║"));
	console.log(chalk.cyan("  ║                                                      ║"));
	console.log(chalk.cyan("  ╚══════════════════════════════════════════════════════╝"));
	console.log("");
	console.log(chalk.dim(`  Get your key → ${info.url}`));
	console.log("");

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const key = await new Promise<string>((resolve) => {
		rl.question(chalk.white("  Paste your API key: "), (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});

	if (!key) {
		console.log(chalk.red("\n  ✗ No key provided. Set it manually:\n"));
		console.log(chalk.white(`    export ${info.env}=sk-...\n`));
		process.exit(1);
	}

	// Save to ~/.truman/.env
	if (!fileExists(globalDir)) mkDir(globalDir, { recursive: true });

	if (fileExists(globalEnv)) {
		let content = readFile(globalEnv, "utf-8");
		if (content.match(new RegExp(`^${info.env}=`, "m"))) {
			content = content.replace(new RegExp(`^${info.env}=.*$`, "m"), `${info.env}=${key}`);
		} else {
			content = `${content.trimEnd()}\n${info.env}=${key}\n`;
		}
		writeFile(globalEnv, content, "utf-8");
	} else {
		writeFile(globalEnv, `${info.env}=${key}\n`, "utf-8");
	}

	process.env[info.env] = key;

	console.log("");
	console.log(chalk.green("  ✓ Key saved to ~/.truman/.env"));
	console.log(chalk.dim("    You won't be asked again.\n"));
}

// ─── Auto-install Playwright ────────────────────────────────────

async function autoInstallPlaywright(): Promise<void> {
	const { execSync } = await import("node:child_process");

	const lines = [
		"  ╔══════════════════════════════════════════════════════╗",
		"  ║                                                      ║",
		"  ║   🎭 TRUMAN SETUP                                    ║",
		"  ║                                                      ║",
		"  ║   Your synthetic users need a browser.               ║",
		"  ║   They can't judge your app without one.             ║",
		"  ║                                                      ║",
		"  ║   Installing Playwright...                           ║",
		"  ║                                                      ║",
		"  ╚══════════════════════════════════════════════════════╝",
	];

	console.log("");
	for (const line of lines) {
		console.log(chalk.green(line));
		await sleep(80);
	}
	console.log("");

	// Resolve playwright CLI from the same node_modules as truman-cli
	// so npx-installed truman uses its own playwright, not a global one
	let playwrightCliCmd = "npx playwright";
	try {
		const { createRequire } = await import("node:module");
		const { dirname, join: pJoin } = await import("node:path");
		const require = createRequire(import.meta.url);
		const playwrightPkg = dirname(require.resolve("playwright/package.json"));
		const cliPath = pJoin(playwrightPkg, "cli.js");
		playwrightCliCmd = `node "${cliPath}"`;
	} catch {
		// fallback to npx
	}

	const steps = [
		{ msg: "  Downloading Chromium — the NPCs' window to your world...", cmd: `${playwrightCliCmd} install chromium` },
	];

	for (const step of steps) {
		process.stdout.write(chalk.dim(step.msg));
		try {
			execSync(step.cmd, { stdio: "pipe", timeout: 120_000 });
			console.log(chalk.green(" ✓"));
		} catch {
			console.log(chalk.red(" ✗"));
			throw new Error(`Failed: ${step.cmd}`);
		}
	}

	const ready = [
		"",
		chalk.green("  ╔══════════════════════════════════════════════════════╗"),
		chalk.green("  ║                                                      ║"),
		chalk.green("  ║   ✓ Setup complete.                                  ║"),
		chalk.green("  ║                                                      ║"),
		chalk.green("  ║   Your users are fake.                               ║"),
		chalk.green("  ║   They just don't know it yet.                       ║"),
		chalk.green("  ║                                                      ║"),
		chalk.green("  ╚══════════════════════════════════════════════════════╝"),
		"",
	];

	for (const line of ready) {
		console.log(line);
		await sleep(60);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Helpers ────────────────────────────────────────────────────

function createEventLogger(): (event: EngineEvent) => void {
	const memberGoals = new Map<string, string>();
	return (event) => {
		switch (event.type) {
			case "simulation:start":
				console.log(
					chalk.green(`  ▶ Simulation started with ${event.families.length} families: ${event.families.join(", ")}`),
				);
				break;
			case "session:start":
				console.log(chalk.cyan(`  ● Session ${event.sessionId.slice(0, 8)} started for ${event.memberId}`));
				break;
			case "action:after": {
				const icon = event.log.result.success ? chalk.green("✓") : chalk.red("✗");
				const duration = chalk.dim(`${event.log.result.duration}ms`);
				const mood = event.log.decision.mood ? chalk.dim(` [${event.log.decision.mood}]`) : "";
				console.log(`    ${icon} ${event.log.memberName}: ${event.log.action} ${duration}${mood}`);
				// Show NPC's goal if new or changed
				const goal = event.log.decision.goal;
				const prevGoal = memberGoals.get(event.log.memberId);
				if (goal && goal !== prevGoal) {
					console.log(chalk.yellow(`       🎯 Goal: "${goal}"`));
					memberGoals.set(event.log.memberId, goal);
				}
				// Show NPC's inner monologue
				const thought = event.log.decision.thought;
				if (thought && thought.length > 3) {
					console.log(chalk.italic.dim(`       💬 "${thought}"`));
				}
				break;
			}
			case "session:end":
				console.log(chalk.cyan(`  ● Session ${event.sessionId.slice(0, 8)} ended (${event.actions} actions)`));
				break;
			case "member:frustrated": {
				console.log(chalk.yellow(`  ⚠ ${event.memberId} frustrated (${(event.level * 100).toFixed(0)}%) — rage quit`));
				const lastThought = (event as any).thought;
				if (lastThought && lastThought.length > 3) {
					console.log(chalk.red.italic(`       🚪 "${lastThought}"`));
				}
				break;
			}
			case "issue:detected":
				console.log(chalk.red(`  ! Issue: ${event.issue.action} — ${event.issue.error}`));
				break;
			case "scenario:start":
				console.log(chalk.magenta(`  📋 Scenario "${event.scenarioId}" started for ${event.actor}`));
				console.log(chalk.dim(`     Goal: ${event.goal.replace(/\s+/g, " ").slice(0, 60)}...`));
				break;
			case "scenario:end": {
				const sr = event.result;
				const passed = sr.criteriaResults.filter((c) => c.passed).length;
				const total = sr.criteriaResults.length;
				const sIcon = sr.success ? chalk.green("✓") : chalk.red("✗");
				console.log(chalk.magenta(`  📋 ${sIcon} Scenario "${sr.scenarioId}": ${passed}/${total} criteria passed`));
				break;
			}
			case "simulation:stop":
				console.log(chalk.yellow(`\n  ■ Simulation stopped: ${event.reason}\n`));
				break;
		}
	};
}

type ScenarioResultEntry = {
	scenarioId: string;
	actor: string;
	goal: string;
	success: boolean;
	criteriaResults: { criterion: { type: string }; passed: boolean; detail: string }[];
	actionsTaken: string[];
	totalActions: number;
	duration: number;
};

type DiscoverabilityEntry = {
	overallScore: number;
	featureBreakdown: {
		feature: string;
		discovered: boolean;
		stepsToDiscover: number | null;
		discoveredBy: string[];
		organic: boolean;
	}[];
	briefingCorrelation: number;
	emptyStateReactions: { action: string; member: string; reaction: string }[];
};

type FullReport = {
	generatedAt: string;
	duration: string;
	scenarioResults?: ScenarioResultEntry[];
	discoverability?: DiscoverabilityEntry;
	families: {
		familyId: string;
		familyName: string;
		lifestyle: string;
		members: {
			memberId: string;
			memberName: string;
			role: string;
			sessionsRun: number;
			actionsPerformed: number;
			successRate: number;
			avgFrustration: number;
			discoveredFeatures: string[];
			blockedFeatures: string[];
			topIssues: string[];
		}[];
		issues: { timestamp: string; action: string; error: string; frustration: number; memberMood: string }[];
	}[];
	summary: {
		totalFamilies: number;
		totalMembers: number;
		totalActions: number;
		overallSuccessRate: number;
		criticalIssues: unknown[];
		uxBlockers: { feature: string; affectedMembers: string[]; description: string }[];
	};
};

type SessionEntry = {
	memberName: string;
	memberId: string;
	familyName: string;
	familyId: string;
	memberRole: string;
	action: string;
	decision: { reasoning: string; mood: string; frustration: number; thought?: string };
	result: { success: boolean; statusCode: number; duration: number };
};

// ─── Rich terminal report ───────────────────────────────────────

const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", vr: "├", vl: "┤", hd: "┬", hu: "┴" };
const W = 72; // report width

function line(left: string, right: string, fill = BOX.h) {
	return left + fill.repeat(W - 2) + right;
}

function pad(text: string, width: number, align: "left" | "right" | "center" = "left"): string {
	// Strip ANSI for length calculation
	const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
	const diff = width - stripped.length;
	if (diff <= 0) return text;
	if (align === "right") return " ".repeat(diff) + text;
	if (align === "center") return " ".repeat(Math.floor(diff / 2)) + text + " ".repeat(Math.ceil(diff / 2));
	return text + " ".repeat(diff);
}

function bar(ratio: number, width: number): string {
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const color = ratio >= 0.9 ? chalk.green : ratio >= 0.6 ? chalk.yellow : chalk.red;
	return color("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

function rateColor(rate: number): string {
	const pct = `${(rate * 100).toFixed(0)}%`;
	if (rate >= 0.95) return chalk.green.bold(pct);
	if (rate >= 0.7) return chalk.yellow.bold(pct);
	return chalk.red.bold(pct);
}

function frustrationIcon(f: number): string {
	if (f === 0) return chalk.green("😊");
	if (f < 0.3) return chalk.yellow("😐");
	if (f < 0.6) return chalk.hex("#FF8800")("😤");
	return chalk.red("🤬");
}

function roleIcon(role: string): string {
	if (role === "child") return "👦";
	if (role === "teen") return "🧑";
	return "👤";
}

function moodSummary(entries: SessionEntry[]): Map<string, number> {
	const moods = new Map<string, number>();
	for (const e of entries) {
		const m = e.decision.mood || "unknown";
		moods.set(m, (moods.get(m) ?? 0) + 1);
	}
	return moods;
}

function printReportSummary(report: FullReport, sessionLogDir?: string): void {
	const s = report.summary;
	const rate = s.overallSuccessRate;

	// Load session entries if available
	let sessions: SessionEntry[] = [];
	const logDir = sessionLogDir ?? resolve(".truman/logs");
	if (existsSync(logDir)) {
		const sessionFiles = readdirSync(logDir)
			.filter((f) => f.startsWith("session-"))
			.sort();
		const latest = sessionFiles.pop();
		if (latest) {
			const raw = readFileSync(join(logDir, latest), "utf-8");
			sessions = raw
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// HEADER
	// ═══════════════════════════════════════════════════════════════════
	console.log();
	console.log(chalk.cyan(line(BOX.tl, BOX.tr)));
	console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  🎬 TRUMAN SIMULATION REPORT"), W - 2) + chalk.cyan(BOX.v));
	console.log(
		chalk.cyan(BOX.v) +
			pad(
				chalk.dim(
					`  ${new Date(report.generatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}`,
				),
				W - 2,
			) +
			chalk.cyan(BOX.v),
	);
	console.log(chalk.cyan(line(BOX.vr, BOX.vl)));

	// ═══════════════════════════════════════════════════════════════════
	// OVERVIEW STATS
	// ═══════════════════════════════════════════════════════════════════
	const statsLeft = `  ${chalk.dim("Duration")} ${chalk.white.bold(report.duration)}   ${chalk.dim("Families")} ${chalk.white.bold(String(s.totalFamilies))}   ${chalk.dim("NPCs")} ${chalk.white.bold(String(s.totalMembers))}`;
	console.log(chalk.cyan(BOX.v) + pad(statsLeft, W - 2) + chalk.cyan(BOX.v));

	const actionsLine = `  ${chalk.dim("Actions")} ${chalk.white.bold(String(s.totalActions))}   ${chalk.dim("Success")} ${rateColor(rate)}   ${bar(rate, 20)}`;
	console.log(chalk.cyan(BOX.v) + pad(actionsLine, W - 2) + chalk.cyan(BOX.v));
	console.log(chalk.cyan(line(BOX.vr, BOX.vl)));

	// ═══════════════════════════════════════════════════════════════════
	// PER-FAMILY BREAKDOWN
	// ═══════════════════════════════════════════════════════════════════
	for (const family of report.families) {
		const familyActions = family.members.reduce((s, m) => s + m.actionsPerformed, 0);
		const familySuccesses = family.members.reduce((s, m) => s + Math.round(m.actionsPerformed * m.successRate), 0);
		const familyRate = familyActions > 0 ? familySuccesses / familyActions : 1;

		console.log(
			chalk.cyan(BOX.v) +
				pad(
					`  ${chalk.bold.white(`🏠 ${(family.familyName || family.familyId).toUpperCase()}`)}   ${rateColor(familyRate)} ${bar(familyRate, 15)}   ${chalk.dim(`${familyActions} actions`)}`,
					W - 2,
				) +
				chalk.cyan(BOX.v),
		);
		console.log(chalk.cyan(BOX.v) + pad("", W - 2) + chalk.cyan(BOX.v));

		for (const member of family.members) {
			const memberSessions = sessions.filter((e) => e.memberId === member.memberId);
			const moods = moodSummary(memberSessions);
			const topMood = [...moods.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

			const icon = roleIcon(member.role);
			const name = pad(chalk.bold(member.memberName !== member.memberId ? member.memberName : member.memberId), 14);
			const acts = pad(chalk.dim(`${member.actionsPerformed} acts`), 10, "right");
			const rateStr = pad(rateColor(member.successRate), 8, "right");
			const frust = frustrationIcon(member.avgFrustration);
			const moodStr = topMood ? chalk.dim(` ${topMood}`) : "";
			const features =
				member.discoveredFeatures.length > 0
					? chalk.dim(" → ") + chalk.white(member.discoveredFeatures.join(", "))
					: "";

			console.log(
				chalk.cyan(BOX.v) +
					pad(`    ${icon} ${name} ${acts} ${rateStr}  ${frust}${moodStr}${features}`, W - 2) +
					chalk.cyan(BOX.v),
			);

			// Show issues inline
			if (member.topIssues.length > 0) {
				for (const issue of member.topIssues.slice(0, 2)) {
					console.log(
						chalk.cyan(BOX.v) + pad(`       ${chalk.red("✗")} ${chalk.dim(issue)}`, W - 2) + chalk.cyan(BOX.v),
					);
				}
			}
		}
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// ACTION HEATMAP
	// ═══════════════════════════════════════════════════════════════════
	if (sessions.length > 0) {
		const actionStats = new Map<string, { total: number; ok: number; avgMs: number }>();
		for (const e of sessions) {
			const prev = actionStats.get(e.action) ?? { total: 0, ok: 0, avgMs: 0 };
			const newTotal = prev.total + 1;
			const newOk = prev.ok + (e.result.success ? 1 : 0);
			const newAvgMs = (prev.avgMs * prev.total + e.result.duration) / newTotal;
			actionStats.set(e.action, { total: newTotal, ok: newOk, avgMs: newAvgMs });
		}

		console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  📊 ACTIONS"), W - 2) + chalk.cyan(BOX.v));
		console.log(
			chalk.cyan(BOX.v) +
				pad(
					`    ${pad(chalk.dim("Action"), 22)} ${pad(chalk.dim("Calls"), 7, "right")} ${pad(chalk.dim("Rate"), 7, "right")} ${pad(chalk.dim("Avg"), 8, "right")}  ${chalk.dim("Distribution")}`,
					W - 2,
				) +
				chalk.cyan(BOX.v),
		);

		const sorted = [...actionStats.entries()].sort((a, b) => b[1].total - a[1].total);
		for (const [action, stats] of sorted) {
			const r = stats.total > 0 ? stats.ok / stats.total : 1;
			const actName = pad(chalk.white(action), 22);
			const calls = pad(String(stats.total), 7, "right");
			const rStr = pad(rateColor(r), 7, "right");
			const avgMs = pad(chalk.dim(`${Math.round(stats.avgMs)}ms`), 8, "right");
			const miniBar = bar(stats.total / sessions.length, 12);
			console.log(
				chalk.cyan(BOX.v) + pad(`    ${actName} ${calls} ${rStr} ${avgMs}  ${miniBar}`, W - 2) + chalk.cyan(BOX.v),
			);
		}
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// MOOD CLOUD
	// ═══════════════════════════════════════════════════════════════════
	if (sessions.length > 0) {
		const allMoods = moodSummary(sessions);
		const sortedMoods = [...allMoods.entries()].sort((a, b) => b[1] - a[1]);

		console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  🧠 MOOD CLOUD"), W - 2) + chalk.cyan(BOX.v));
		let moodLine = "    ";
		for (const [mood, count] of sortedMoods) {
			const moodColors: Record<string, (s: string) => string> = {
				calm: chalk.blue,
				happy: chalk.green,
				excited: chalk.magenta,
				rushed: chalk.yellow,
				annoyed: chalk.red,
				confused: chalk.hex("#FF8800"),
				bored: chalk.dim,
				curious: chalk.cyan,
				patient: chalk.green,
				enthusiastic: chalk.magenta,
				neutral: chalk.dim,
				hopeful: chalk.cyan,
				impatient: chalk.yellow,
				determined: chalk.white,
			};
			const colorFn = moodColors[mood] ?? chalk.white;
			const size = count >= 10 ? chalk.bold : (s: string) => s;
			moodLine += `${size(colorFn(`${mood}(${count})`))}  `;
		}
		console.log(chalk.cyan(BOX.v) + pad(moodLine, W - 2) + chalk.cyan(BOX.v));
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// BLOCKERS + ISSUES
	// ═══════════════════════════════════════════════════════════════════
	if (s.uxBlockers.length > 0 || s.criticalIssues.length > 0) {
		console.log(chalk.cyan(BOX.v) + pad(chalk.bold.red("  🚧 UX BLOCKERS"), W - 2) + chalk.cyan(BOX.v));
		for (const b of s.uxBlockers) {
			console.log(
				chalk.cyan(BOX.v) +
					pad(
						`    ${chalk.red("■")} ${chalk.bold(b.feature)} ${chalk.dim("—")} ${b.affectedMembers.map((m) => chalk.yellow(m)).join(", ")}`,
						W - 2,
					) +
					chalk.cyan(BOX.v),
			);
		}
		if (s.criticalIssues.length > 0) {
			console.log(
				chalk.cyan(BOX.v) +
					pad(`    ${chalk.red.bold(`🔥 ${s.criticalIssues.length} critical issues (frustration ≥70%)`)}`, W - 2) +
					chalk.cyan(BOX.v),
			);
		}
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// SAMPLE REASONING (Top 3 most interesting decisions)
	// ═══════════════════════════════════════════════════════════════════
	if (sessions.length > 0) {
		// Pick diverse: one success, one failure, one high-frustration
		const interesting: SessionEntry[] = [];
		const failed = sessions.find((e) => !e.result.success);
		const highFrust = sessions.find((e) => e.decision.frustration > 0.3);
		const firstAction = sessions[0];
		if (failed) interesting.push(failed);
		if (highFrust && highFrust !== failed) interesting.push(highFrust);
		if (firstAction && !interesting.includes(firstAction)) interesting.push(firstAction);

		if (interesting.length > 0) {
			console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  💭 NPC DIARY"), W - 2) + chalk.cyan(BOX.v));
			for (const e of interesting.slice(0, 5)) {
				const icon = e.result.success ? chalk.green("✓") : chalk.red("✗");
				// Prefer thought (the unfiltered monologue), fall back to reasoning
				const quote = e.decision.thought && e.decision.thought.length > 3 ? e.decision.thought : e.decision.reasoning;
				const truncated = quote.length > 62 ? `${quote.slice(0, 59)}...` : quote;
				console.log(
					chalk.cyan(BOX.v) +
						pad(`    ${icon} ${chalk.bold(e.memberName)} ${chalk.dim(`(${e.decision.mood})`)}`, W - 2) +
						chalk.cyan(BOX.v),
				);
				console.log(chalk.cyan(BOX.v) + pad(`      ${chalk.italic.dim(`"${truncated}"`)}`, W - 2) + chalk.cyan(BOX.v));
			}
			console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// SCENARIOS
	// ═══════════════════════════════════════════════════════════════════
	if (report.scenarioResults?.length) {
		console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  📋 SCENARIOS"), W - 2) + chalk.cyan(BOX.v));
		for (const sr of report.scenarioResults) {
			const icon = sr.success ? chalk.green("✓") : chalk.red("✗");
			const passed = sr.criteriaResults.filter((c) => c.passed).length;
			const total = sr.criteriaResults.length;
			const goalShort = sr.goal.replace(/\s+/g, " ").slice(0, 40);
			console.log(
				chalk.cyan(BOX.v) +
					pad(
						`    ${icon} ${chalk.bold(sr.scenarioId)} ${chalk.dim(`(${sr.actor})`)} ${passed}/${total} criteria`,
						W - 2,
					) +
					chalk.cyan(BOX.v),
			);
			console.log(chalk.cyan(BOX.v) + pad(`      ${chalk.dim(`${goalShort}...`)}`, W - 2) + chalk.cyan(BOX.v));
			for (const cr of sr.criteriaResults) {
				const ci = cr.passed ? chalk.green("✓") : chalk.red("✗");
				console.log(
					chalk.cyan(BOX.v) + pad(`      ${ci} ${chalk.dim(cr.detail.slice(0, 55))}`, W - 2) + chalk.cyan(BOX.v),
				);
			}
		}
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// DISCOVERABILITY
	// ═══════════════════════════════════════════════════════════════════
	if (report.discoverability) {
		const d = report.discoverability;
		const scoreColor = d.overallScore >= 70 ? chalk.green : d.overallScore >= 40 ? chalk.yellow : chalk.red;
		console.log(
			chalk.cyan(BOX.v) +
				pad(`  ${chalk.bold.white("🔍 DISCOVERABILITY:")} ${scoreColor.bold(`${String(d.overallScore)}/100`)}`, W - 2) +
				chalk.cyan(BOX.v),
		);

		for (const f of d.featureBreakdown) {
			const icon = f.discovered ? chalk.green("✓") : chalk.red("✗");
			const steps = f.stepsToDiscover !== null ? chalk.dim(`${f.stepsToDiscover} steps`) : chalk.dim("never");
			const organic = f.organic ? chalk.cyan(" (organic)") : "";
			const npcCount = f.discoveredBy.length > 0 ? `${f.discoveredBy.length} NPCs` : "";
			console.log(
				chalk.cyan(BOX.v) +
					pad(`    ${icon} ${pad(f.feature, 12)} ${pad(npcCount, 8)} ${pad(steps, 10)}${organic}`, W - 2) +
					chalk.cyan(BOX.v),
			);
		}

		const correlationPct = `${Math.round(d.briefingCorrelation * 100)}%`;
		const emptyCreated = d.emptyStateReactions.filter((e) => e.reaction === "created").length;
		const emptyTotal = d.emptyStateReactions.length;
		const emptyStr = emptyTotal > 0 ? `${emptyCreated}/${emptyTotal}` : "n/a";
		console.log(
			chalk.cyan(BOX.v) +
				pad(
					`    ${chalk.dim("Action correlation:")} ${correlationPct}   ${chalk.dim("Empty → Create:")} ${emptyStr}`,
					W - 2,
				) +
				chalk.cyan(BOX.v),
		);
		console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
	}

	// ═══════════════════════════════════════════════════════════════════
	// BEST QUOTES — what your synthetic users actually thought
	// ═══════════════════════════════════════════════════════════════════
	if (sessions.length > 0) {
		const quotes = sessions
			.filter((e) => e.decision.thought && e.decision.thought.length > 5)
			.map((e) => ({
				text: e.decision.thought!,
				name: e.memberName,
				role: e.memberRole,
				frustration: e.decision.frustration,
				success: e.result.success,
			}))
			// Prefer frustrated, failed, or funny — sort by frustration desc
			.sort((a, b) => b.frustration - a.frustration);

		if (quotes.length > 0) {
			const top = quotes.slice(0, 5);
			console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white("  💬 WHAT YOUR USERS SAID"), W - 2) + chalk.cyan(BOX.v));
			for (const q of top) {
				const icon = q.success ? chalk.dim("·") : chalk.red("✗");
				const frustBar =
					q.frustration > 0.6 ? chalk.red("🔥") : q.frustration > 0.3 ? chalk.yellow("😤") : chalk.dim("  ");
				const truncated = q.text.length > 50 ? `${q.text.slice(0, 47)}...` : q.text;
				console.log(
					chalk.cyan(BOX.v) + pad(`  ${icon} ${frustBar} ${chalk.italic(`"${truncated}"`)}`, W - 2) + chalk.cyan(BOX.v),
				);
				console.log(
					chalk.cyan(BOX.v) + pad(`       ${chalk.dim(`— ${q.name}, ${q.role}`)}`, W - 2) + chalk.cyan(BOX.v),
				);
			}
			console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// VERDICT
	// ═══════════════════════════════════════════════════════════════════
	let verdict: string;
	let verdictIcon: string;
	if (rate >= 0.95) {
		verdict = "EXCELLENT — NPCs had a smooth experience";
		verdictIcon = "🟢";
	} else if (rate >= 0.8) {
		verdict = "GOOD — Minor issues found";
		verdictIcon = "🟡";
	} else if (rate >= 0.5) {
		verdict = "NEEDS WORK — Several features are broken";
		verdictIcon = "🟠";
	} else {
		verdict = "CRITICAL — Major API failures detected";
		verdictIcon = "🔴";
	}
	console.log(chalk.cyan(BOX.v) + pad(`  ${verdictIcon} ${chalk.bold(verdict)}`, W - 2) + chalk.cyan(BOX.v));
	console.log(chalk.cyan(line(BOX.bl, BOX.br)));
	console.log();
}

async function loadAdapterConfig(path: string) {
	const absPath = resolve(path);
	const raw = readFileSync(absPath, "utf-8");

	if (absPath.endsWith(".yaml") || absPath.endsWith(".yml")) {
		const { parse } = await import("yaml");
		return parse(raw);
	}

	return JSON.parse(raw);
}

program.parse();
