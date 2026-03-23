#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { SimulationEngine } from './engine/SimulationEngine.js';
import { HttpApiAdapter } from './adapters/HttpApiAdapter.js';
import { createProvider } from './agent/providers/types.js';
import { LiveDashboard } from './observer/LiveDashboard.js';
import { writeJUnitReport } from './observer/JUnitReporter.js';
import { VoiceNarrator } from './observer/VoiceNarrator.js';
import { loadFamilies } from './family/FamilyLoader.js';
import type { EngineEvent, SimulationConfig } from './types.js';

const program = new Command();

program
  .name('truman')
  .description('Your app\'s users are fake. They just don\'t know it yet.')
  .version('0.1.0');

// ─── Run command ────────────────────────────────────────────────

program
  .command('run')
  .description('Start the Truman simulation')
  .requiredOption('-f, --families <paths...>', 'Path(s) to family YAML configs')
  .option('-a, --adapter <path>', 'Path to adapter config (JSON/YAML)', './adapter.json')
  .option('-p, --provider <type>', 'LLM provider: openai | ollama | anthropic', 'openai')
  .option('-m, --model <name>', 'LLM model name', 'gpt-4o-mini')
  .option('-s, --speed <number>', 'Time multiplier (1=realtime, 60=1min→1hr)', '1')
  .option('--once', 'Run one session per member then exit', false)
  .option('--tick <ms>', 'Tick interval in milliseconds', '60000')
  .option('--concurrency <n>', 'Max concurrent sessions', '3')
  .option('--log-dir <path>', 'Directory for logs', './.truman/logs')
  .option('--state-dir <path>', 'Directory for persistent state', './.truman/state')
  .option('--live', 'Show live animated dashboard instead of scrolling log')
  .option('--junit <path>', 'Write JUnit XML report for CI (e.g. --junit truman-results.xml)')
  .option('--browser', 'Use Playwright browser adapter (NPC navigates real UI)')
  .option('--headed', 'Show browser window (implies --browser)')
  .option('--stress', 'Stress test: all NPC members run in parallel (concurrent API load)')
  .option('--voice', 'Enable voice narration — NPCs speak their frustrations (macOS)')
  .action(async (opts) => {
    console.log(chalk.bold.cyan('\n  🎬 Truman v0.1.0\n'));
    console.log(chalk.dim('  Your app\'s users are fake. They just don\'t know it yet.\n'));

    let playwrightAdapter: any = null;
    try {
      const provider = await createProvider({
        type: opts.provider,
        model: opts.model,
      });

      const useBrowser = opts.browser || opts.headed;
      let adapter;

      if (useBrowser) {
        const { PlaywrightAdapter } = await import('./adapters/PlaywrightAdapter.js');
        const adapterConfig = await loadAdapterConfig(opts.adapter);
        playwrightAdapter = new PlaywrightAdapter({
          baseUrl: adapterConfig.baseUrl.replace('/api', ''),
          headless: !opts.headed,
          screenshotDir: resolve('.truman/screenshots'),
          slowMo: opts.headed ? 100 : 0,
        });
        adapter = playwrightAdapter;
        console.log(chalk.cyan(`  🌐 Browser mode${opts.headed ? ' (headed)' : ' (headless)'}\n`));
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
        const narrator = new VoiceNarrator(true);
        const families = loadFamilies(opts.families.map((f: string) => resolve(f)));
        for (const family of families) {
          for (const member of family.members) {
            narrator.assignVoice(member.id, member.role);
          }
        }
        engine.on((event) => narrator.handleEvent(event));
        console.log(chalk.magenta('  🎙️  Voice narration ON — NPCs will speak their minds.\n'));
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
        else console.log(chalk.yellow('\n\n  Stopping simulation...'));
        await engine.stop();
        if (playwrightAdapter) await playwrightAdapter.close();
        const report = engine.generateReport();
        printReportSummary(report as FullReport, resolve(opts.logDir));
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      if (opts.once || opts.stress) {
        if (opts.stress) console.log(chalk.red.bold('  ⚡ STRESS MODE — all NPCs running in parallel\n'));
        await engine.runOnce(!!opts.stress);
        if (dashboard) dashboard.stop();
        if (playwrightAdapter) await playwrightAdapter.close();
        const report = engine.generateReport();
        printReportSummary(report as FullReport, resolve(opts.logDir));
        if (opts.junit) {
          writeJUnitReport(report as any, resolve(opts.junit));
          console.log(chalk.dim(`  JUnit report written to ${opts.junit}\n`));
        }
        if (useBrowser) {
          const screenshots = resolve('.truman/screenshots');
          console.log(chalk.dim(`  📸 Screenshots saved to ${screenshots}`));
          console.log(chalk.dim(`  📋 Decision manifest: .truman/logs/manifest-*.json\n`));
        }
      } else {
        await engine.start();
        if (!dashboard) console.log(chalk.dim('  Press Ctrl+C to stop\n'));
      }
    } catch (err) {
      if (playwrightAdapter) await playwrightAdapter.close().catch(() => {});
      console.error(chalk.red(`\n  Error: ${err instanceof Error ? err.message : err}\n`));
      process.exit(1);
    }
  });

// ─── Validate command ───────────────────────────────────────────

program
  .command('validate')
  .description('Validate family YAML configs without running')
  .argument('<paths...>', 'Family YAML file paths')
  .action(async (paths: string[]) => {
    const { loadFamily } = await import('./family/FamilyLoader.js');

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
  .command('preview')
  .description('Preview upcoming scheduled actions')
  .requiredOption('-f, --families <paths...>', 'Family YAML files')
  .option('-n, --count <number>', 'How many upcoming tasks to show', '20')
  .action(async (opts) => {
    const { loadFamilies } = await import('./family/FamilyLoader.js');
    const { Scheduler } = await import('./engine/Scheduler.js');

    const families = loadFamilies(opts.families.map((f: string) => resolve(f)));
    const scheduler = new Scheduler(1);

    console.log(chalk.bold.cyan('\n  📅 Truman — Upcoming Actions\n'));

    const upcoming = scheduler.getUpcoming(families, Number(opts.count));

    if (upcoming.length === 0) {
      console.log(chalk.dim('  No scheduled actions in the next 24 hours'));
      return;
    }

    for (const task of upcoming) {
      const time = new Date(task.fireAt).toLocaleTimeString('en-US', { hour12: false });
      const day = new Date(task.fireAt).toLocaleDateString('en-US', { weekday: 'short' });
      console.log(
        `  ${chalk.dim(day)} ${chalk.white(time)}  ${chalk.cyan(task.member.name)} ${chalk.dim('→')} ${task.schedule.action} ${chalk.dim(`(${(task.schedule.probability * 100).toFixed(0)}%)`)}`,
      );
    }
    console.log();
  });

// ─── Report command ─────────────────────────────────────────────

program
  .command('report')
  .description('View reports from previous runs')
  .option('--log-dir <path>', 'Log directory', './.truman/logs')
  .action((opts) => {
    const logDir = resolve(opts.logDir);

    if (!existsSync(logDir)) {
      console.log(chalk.dim('\n  No logs found. Run a simulation first.\n'));
      return;
    }

    const files = readdirSync(logDir).filter((f) => f.startsWith('report-'));
    if (files.length === 0) {
      console.log(chalk.dim('\n  No reports found.\n'));
      return;
    }

    const latest = files.sort().pop()!;
    const reportPath = join(logDir, latest);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    printReportSummary(report as FullReport, logDir);
  });

// ─── Init command ───────────────────────────────────────────────

program
  .command('init')
  .description('Generate Truman config from OpenAPI spec or by probing a URL')
  .option('-d, --dir <path>', 'Output directory for generated files', '.')
  .option('--swagger <path>', 'Path to OpenAPI/Swagger spec (JSON or YAML)')
  .option('--url <baseUrl>', 'Base URL to probe for API endpoints')
  .action(async (opts) => {
    const { SetupGenerator } = await import('./init/SetupGenerator.js');
    const generator = new SetupGenerator();
    const dir = resolve(opts.dir);

    console.log(chalk.bold.cyan('\n  🎬 Truman — Setup\n'));

    let result;
    if (opts.swagger) {
      console.log(chalk.dim(`  Importing from OpenAPI spec: ${opts.swagger}\n`));
      result = generator.generateFromSpec(opts.swagger, dir, opts.url);
    } else if (opts.url) {
      console.log(chalk.dim(`  Probing ${opts.url} for API endpoints...\n`));
      result = await generator.generateFromUrl(opts.url, dir);
    } else {
      // No spec or URL — create empty skeleton
      const familiesDir = join(dir, 'families');
      const adaptersDir = join(dir, 'adapters');
      if (!existsSync(familiesDir)) mkdirSync(familiesDir, { recursive: true });
      if (!existsSync(adaptersDir)) mkdirSync(adaptersDir, { recursive: true });
      console.log(chalk.green('  ✓'), 'Created directories');
      result = null;
    }

    if (result) {
      const { stats } = result;
      const modeIcon = stats.mode === 'merged' ? '🔄' : '✨';
      console.log(chalk.green(`  ${modeIcon}`), stats.mode === 'merged'
        ? `Merged: ${chalk.bold(String(stats.added))} new + ${chalk.dim(String(stats.skipped))} existing = ${stats.added + stats.skipped} endpoints`
        : `Created: ${chalk.bold(String(stats.total))} endpoints`);
      console.log(chalk.green('  ✓'), `Adapter: ${result.adapterPath}`);
      if (result.familyPath) {
        console.log(chalk.green('  ✓'), `Family:  ${result.familyPath}`);
      } else {
        console.log(chalk.dim('  ─'), 'Family YAML already exists (not overwritten)');
      }
    }

    console.log(chalk.dim('\n  Next steps:'));
    console.log(chalk.dim('  1. Review and customize the generated adapter.json'));
    console.log(chalk.dim('  2. Edit the family YAML — add personas, schedules, scenarios'));
    console.log(chalk.dim('  3. Run: truman run -f families/*.yaml -a adapters/adapter.json --once'));
    console.log(chalk.dim('\n  Or let Claude Code do it:'));
    console.log(chalk.white('  "Scan my API routes and generate Truman families with realistic scenarios"\n'));
  });

// ─── Helpers ────────────────────────────────────────────────────

function createEventLogger(): (event: EngineEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'simulation:start':
        console.log(chalk.green(`  ▶ Simulation started with ${event.families.length} families: ${event.families.join(', ')}`));
        break;
      case 'session:start':
        console.log(chalk.cyan(`  ● Session ${event.sessionId.slice(0, 8)} started for ${event.memberId}`));
        break;
      case 'action:after': {
        const icon = event.log.result.success ? chalk.green('✓') : chalk.red('✗');
        const duration = chalk.dim(`${event.log.result.duration}ms`);
        const mood = event.log.decision.mood ? chalk.dim(` [${event.log.decision.mood}]`) : '';
        console.log(`    ${icon} ${event.log.memberName}: ${event.log.action} ${duration}${mood}`);
        break;
      }
      case 'session:end':
        console.log(chalk.cyan(`  ● Session ${event.sessionId.slice(0, 8)} ended (${event.actions} actions)`));
        break;
      case 'member:frustrated':
        console.log(chalk.yellow(`  ⚠ ${event.memberId} frustrated (${(event.level * 100).toFixed(0)}%) — aborting session`));
        break;
      case 'issue:detected':
        console.log(chalk.red(`  ! Issue: ${event.issue.action} — ${event.issue.error}`));
        break;
      case 'scenario:start':
        console.log(chalk.magenta(`  📋 Scenario "${event.scenarioId}" started for ${event.actor}`));
        console.log(chalk.dim(`     Goal: ${event.goal.replace(/\s+/g, ' ').slice(0, 60)}...`));
        break;
      case 'scenario:end': {
        const sr = event.result;
        const passed = sr.criteriaResults.filter((c) => c.passed).length;
        const total = sr.criteriaResults.length;
        const sIcon = sr.success ? chalk.green('✓') : chalk.red('✗');
        console.log(chalk.magenta(`  📋 ${sIcon} Scenario "${sr.scenarioId}": ${passed}/${total} criteria passed`));
        break;
      }
      case 'simulation:stop':
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
  featureBreakdown: { feature: string; discovered: boolean; stepsToDiscover: number | null; discoveredBy: string[]; organic: boolean }[];
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
  decision: { reasoning: string; mood: string; frustration: number };
  result: { success: boolean; statusCode: number; duration: number };
};

// ─── Rich terminal report ───────────────────────────────────────

const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', vr: '├', vl: '┤', hd: '┬', hu: '┴' };
const W = 72; // report width

function line(left: string, right: string, fill = BOX.h) {
  return left + fill.repeat(W - 2) + right;
}

function pad(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  // Strip ANSI for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = width - stripped.length;
  if (diff <= 0) return text;
  if (align === 'right') return ' '.repeat(diff) + text;
  if (align === 'center') return ' '.repeat(Math.floor(diff / 2)) + text + ' '.repeat(Math.ceil(diff / 2));
  return text + ' '.repeat(diff);
}

function bar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const color = ratio >= 0.9 ? chalk.green : ratio >= 0.6 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

function rateColor(rate: number): string {
  const pct = `${(rate * 100).toFixed(0)}%`;
  if (rate >= 0.95) return chalk.green.bold(pct);
  if (rate >= 0.7) return chalk.yellow.bold(pct);
  return chalk.red.bold(pct);
}

function frustrationIcon(f: number): string {
  if (f === 0) return chalk.green('😊');
  if (f < 0.3) return chalk.yellow('😐');
  if (f < 0.6) return chalk.hex('#FF8800')('😤');
  return chalk.red('🤬');
}

function roleIcon(role: string): string {
  if (role === 'child') return '👦';
  if (role === 'teen') return '🧑';
  return '👤';
}

function moodSummary(entries: SessionEntry[]): Map<string, number> {
  const moods = new Map<string, number>();
  for (const e of entries) {
    const m = e.decision.mood || 'unknown';
    moods.set(m, (moods.get(m) ?? 0) + 1);
  }
  return moods;
}

function printReportSummary(report: FullReport, sessionLogDir?: string): void {
  const s = report.summary;
  const rate = s.overallSuccessRate;

  // Load session entries if available
  let sessions: SessionEntry[] = [];
  const logDir = sessionLogDir ?? resolve('.truman/logs');
  if (existsSync(logDir)) {
    const sessionFiles = readdirSync(logDir).filter(f => f.startsWith('session-')).sort();
    const latest = sessionFiles.pop();
    if (latest) {
      const raw = readFileSync(join(logDir, latest), 'utf-8');
      sessions = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // HEADER
  // ═══════════════════════════════════════════════════════════════════
  console.log();
  console.log(chalk.cyan(line(BOX.tl, BOX.tr)));
  console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white('  🎬 TRUMAN SIMULATION REPORT'), W - 2) + chalk.cyan(BOX.v));
  console.log(chalk.cyan(BOX.v) + pad(chalk.dim(`  ${new Date(report.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`), W - 2) + chalk.cyan(BOX.v));
  console.log(chalk.cyan(line(BOX.vr, BOX.vl)));

  // ═══════════════════════════════════════════════════════════════════
  // OVERVIEW STATS
  // ═══════════════════════════════════════════════════════════════════
  const statsLeft = `  ${chalk.dim('Duration')} ${chalk.white.bold(report.duration)}   ${chalk.dim('Families')} ${chalk.white.bold(String(s.totalFamilies))}   ${chalk.dim('NPCs')} ${chalk.white.bold(String(s.totalMembers))}`;
  console.log(chalk.cyan(BOX.v) + pad(statsLeft, W - 2) + chalk.cyan(BOX.v));

  const actionsLine = `  ${chalk.dim('Actions')} ${chalk.white.bold(String(s.totalActions))}   ${chalk.dim('Success')} ${rateColor(rate)}   ${bar(rate, 20)}`;
  console.log(chalk.cyan(BOX.v) + pad(actionsLine, W - 2) + chalk.cyan(BOX.v));
  console.log(chalk.cyan(line(BOX.vr, BOX.vl)));

  // ═══════════════════════════════════════════════════════════════════
  // PER-FAMILY BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════
  for (const family of report.families) {
    const familyActions = family.members.reduce((s, m) => s + m.actionsPerformed, 0);
    const familySuccesses = family.members.reduce((s, m) => s + Math.round(m.actionsPerformed * m.successRate), 0);
    const familyRate = familyActions > 0 ? familySuccesses / familyActions : 1;

    console.log(chalk.cyan(BOX.v) + pad(`  ${chalk.bold.white('🏠 ' + (family.familyName || family.familyId).toUpperCase())}   ${rateColor(familyRate)} ${bar(familyRate, 15)}   ${chalk.dim(familyActions + ' actions')}`, W - 2) + chalk.cyan(BOX.v));
    console.log(chalk.cyan(BOX.v) + pad('', W - 2) + chalk.cyan(BOX.v));

    for (const member of family.members) {
      const memberSessions = sessions.filter(e => e.memberId === member.memberId);
      const moods = moodSummary(memberSessions);
      const topMood = [...moods.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

      const icon = roleIcon(member.role);
      const name = pad(chalk.bold(member.memberName !== member.memberId ? member.memberName : member.memberId), 14);
      const acts = pad(chalk.dim(`${member.actionsPerformed} acts`), 10, 'right');
      const rateStr = pad(rateColor(member.successRate), 8, 'right');
      const frust = frustrationIcon(member.avgFrustration);
      const moodStr = topMood ? chalk.dim(` ${topMood}`) : '';
      const features = member.discoveredFeatures.length > 0
        ? chalk.dim(' → ') + chalk.white(member.discoveredFeatures.join(', '))
        : '';

      console.log(chalk.cyan(BOX.v) + pad(`    ${icon} ${name} ${acts} ${rateStr}  ${frust}${moodStr}${features}`, W - 2) + chalk.cyan(BOX.v));

      // Show issues inline
      if (member.topIssues.length > 0) {
        for (const issue of member.topIssues.slice(0, 2)) {
          console.log(chalk.cyan(BOX.v) + pad(`       ${chalk.red('✗')} ${chalk.dim(issue)}`, W - 2) + chalk.cyan(BOX.v));
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

    console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white('  📊 ACTIONS'), W - 2) + chalk.cyan(BOX.v));
    console.log(chalk.cyan(BOX.v) + pad(`    ${pad(chalk.dim('Action'), 22)} ${pad(chalk.dim('Calls'), 7, 'right')} ${pad(chalk.dim('Rate'), 7, 'right')} ${pad(chalk.dim('Avg'), 8, 'right')}  ${chalk.dim('Distribution')}`, W - 2) + chalk.cyan(BOX.v));

    const sorted = [...actionStats.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [action, stats] of sorted) {
      const r = stats.total > 0 ? stats.ok / stats.total : 1;
      const actName = pad(chalk.white(action), 22);
      const calls = pad(String(stats.total), 7, 'right');
      const rStr = pad(rateColor(r), 7, 'right');
      const avgMs = pad(chalk.dim(`${Math.round(stats.avgMs)}ms`), 8, 'right');
      const miniBar = bar(stats.total / sessions.length, 12);
      console.log(chalk.cyan(BOX.v) + pad(`    ${actName} ${calls} ${rStr} ${avgMs}  ${miniBar}`, W - 2) + chalk.cyan(BOX.v));
    }
    console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // MOOD CLOUD
  // ═══════════════════════════════════════════════════════════════════
  if (sessions.length > 0) {
    const allMoods = moodSummary(sessions);
    const sortedMoods = [...allMoods.entries()].sort((a, b) => b[1] - a[1]);

    console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white('  🧠 MOOD CLOUD'), W - 2) + chalk.cyan(BOX.v));
    let moodLine = '    ';
    for (const [mood, count] of sortedMoods) {
      const moodColors: Record<string, (s: string) => string> = {
        calm: chalk.blue, happy: chalk.green, excited: chalk.magenta,
        rushed: chalk.yellow, annoyed: chalk.red, confused: chalk.hex('#FF8800'),
        bored: chalk.dim, curious: chalk.cyan, patient: chalk.green,
        enthusiastic: chalk.magenta, neutral: chalk.dim, hopeful: chalk.cyan,
        impatient: chalk.yellow, determined: chalk.white,
      };
      const colorFn = moodColors[mood] ?? chalk.white;
      const size = count >= 10 ? chalk.bold : (s: string) => s;
      moodLine += size(colorFn(`${mood}(${count})`)) + '  ';
    }
    console.log(chalk.cyan(BOX.v) + pad(moodLine, W - 2) + chalk.cyan(BOX.v));
    console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // BLOCKERS + ISSUES
  // ═══════════════════════════════════════════════════════════════════
  if (s.uxBlockers.length > 0 || s.criticalIssues.length > 0) {
    console.log(chalk.cyan(BOX.v) + pad(chalk.bold.red('  🚧 UX BLOCKERS'), W - 2) + chalk.cyan(BOX.v));
    for (const b of s.uxBlockers) {
      console.log(chalk.cyan(BOX.v) + pad(`    ${chalk.red('■')} ${chalk.bold(b.feature)} ${chalk.dim('—')} ${b.affectedMembers.map(m => chalk.yellow(m)).join(', ')}`, W - 2) + chalk.cyan(BOX.v));
    }
    if (s.criticalIssues.length > 0) {
      console.log(chalk.cyan(BOX.v) + pad(`    ${chalk.red.bold(`🔥 ${s.criticalIssues.length} critical issues (frustration ≥70%)`)}`, W - 2) + chalk.cyan(BOX.v));
    }
    console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // SAMPLE REASONING (Top 3 most interesting decisions)
  // ═══════════════════════════════════════════════════════════════════
  if (sessions.length > 0) {
    // Pick diverse: one success, one failure, one high-frustration
    const interesting: SessionEntry[] = [];
    const failed = sessions.find(e => !e.result.success);
    const highFrust = sessions.find(e => e.decision.frustration > 0.3);
    const firstAction = sessions[0];
    if (failed) interesting.push(failed);
    if (highFrust && highFrust !== failed) interesting.push(highFrust);
    if (firstAction && !interesting.includes(firstAction)) interesting.push(firstAction);

    if (interesting.length > 0) {
      console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white('  💭 NPC THOUGHTS'), W - 2) + chalk.cyan(BOX.v));
      for (const e of interesting.slice(0, 3)) {
        const icon = e.result.success ? chalk.green('✓') : chalk.red('✗');
        const truncated = e.decision.reasoning.length > 58
          ? e.decision.reasoning.slice(0, 55) + '...'
          : e.decision.reasoning;
        console.log(chalk.cyan(BOX.v) + pad(`    ${icon} ${chalk.bold(e.memberName)} ${chalk.dim(`(${e.decision.mood})`)}`, W - 2) + chalk.cyan(BOX.v));
        console.log(chalk.cyan(BOX.v) + pad(`      ${chalk.italic.dim(`"${truncated}"`)}`, W - 2) + chalk.cyan(BOX.v));
      }
      console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCENARIOS
  // ═══════════════════════════════════════════════════════════════════
  if (report.scenarioResults?.length) {
    console.log(chalk.cyan(BOX.v) + pad(chalk.bold.white('  📋 SCENARIOS'), W - 2) + chalk.cyan(BOX.v));
    for (const sr of report.scenarioResults) {
      const icon = sr.success ? chalk.green('✓') : chalk.red('✗');
      const passed = sr.criteriaResults.filter((c) => c.passed).length;
      const total = sr.criteriaResults.length;
      const goalShort = sr.goal.replace(/\s+/g, ' ').slice(0, 40);
      console.log(chalk.cyan(BOX.v) + pad(`    ${icon} ${chalk.bold(sr.scenarioId)} ${chalk.dim(`(${sr.actor})`)} ${passed}/${total} criteria`, W - 2) + chalk.cyan(BOX.v));
      console.log(chalk.cyan(BOX.v) + pad(`      ${chalk.dim(goalShort + '...')}`, W - 2) + chalk.cyan(BOX.v));
      for (const cr of sr.criteriaResults) {
        const ci = cr.passed ? chalk.green('✓') : chalk.red('✗');
        console.log(chalk.cyan(BOX.v) + pad(`      ${ci} ${chalk.dim(cr.detail.slice(0, 55))}`, W - 2) + chalk.cyan(BOX.v));
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
    console.log(chalk.cyan(BOX.v) + pad(`  ${chalk.bold.white('🔍 DISCOVERABILITY:')} ${scoreColor.bold(String(d.overallScore) + '/100')}`, W - 2) + chalk.cyan(BOX.v));

    for (const f of d.featureBreakdown) {
      const icon = f.discovered ? chalk.green('✓') : chalk.red('✗');
      const steps = f.stepsToDiscover !== null ? chalk.dim(`${f.stepsToDiscover} steps`) : chalk.dim('never');
      const organic = f.organic ? chalk.cyan(' (organic)') : '';
      const npcCount = f.discoveredBy.length > 0 ? `${f.discoveredBy.length} NPCs` : '';
      console.log(chalk.cyan(BOX.v) + pad(`    ${icon} ${pad(f.feature, 12)} ${pad(npcCount, 8)} ${pad(steps, 10)}${organic}`, W - 2) + chalk.cyan(BOX.v));
    }

    const correlationPct = `${Math.round(d.briefingCorrelation * 100)}%`;
    const emptyCreated = d.emptyStateReactions.filter((e) => e.reaction === 'created').length;
    const emptyTotal = d.emptyStateReactions.length;
    const emptyStr = emptyTotal > 0 ? `${emptyCreated}/${emptyTotal}` : 'n/a';
    console.log(chalk.cyan(BOX.v) + pad(`    ${chalk.dim('Action correlation:')} ${correlationPct}   ${chalk.dim('Empty → Create:')} ${emptyStr}`, W - 2) + chalk.cyan(BOX.v));
    console.log(chalk.cyan(line(BOX.vr, BOX.vl)));
  }

  // ═══════════════════════════════════════════════════════════════════
  // VERDICT
  // ═══════════════════════════════════════════════════════════════════
  let verdict: string;
  let verdictIcon: string;
  if (rate >= 0.95) {
    verdict = 'EXCELLENT — NPCs had a smooth experience';
    verdictIcon = '🟢';
  } else if (rate >= 0.8) {
    verdict = 'GOOD — Minor issues found';
    verdictIcon = '🟡';
  } else if (rate >= 0.5) {
    verdict = 'NEEDS WORK — Several features are broken';
    verdictIcon = '🟠';
  } else {
    verdict = 'CRITICAL — Major API failures detected';
    verdictIcon = '🔴';
  }
  console.log(chalk.cyan(BOX.v) + pad(`  ${verdictIcon} ${chalk.bold(verdict)}`, W - 2) + chalk.cyan(BOX.v));
  console.log(chalk.cyan(line(BOX.bl, BOX.br)));
  console.log();
}

async function loadAdapterConfig(path: string) {
  const absPath = resolve(path);
  const raw = readFileSync(absPath, 'utf-8');

  if (absPath.endsWith('.yaml') || absPath.endsWith('.yml')) {
    const { parse } = await import('yaml');
    return parse(raw);
  }

  return JSON.parse(raw);
}

program.parse();
