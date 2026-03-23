import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionLog,
  SimulationReport,
  FamilyReport,
  MemberReport,
  ReportSummary,
  FamilyState,
  FamilyConfig,
  IssueRecord,
} from '../types.js';
import { DiscoverabilityScorer } from './DiscoverabilityScorer.js';

export class ActionLogger {
  private logDir: string;
  private sessionFile: string;
  private logs: ActionLog[] = [];

  constructor(logDir: string) {
    this.logDir = logDir;
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.sessionFile = join(logDir, `session-${timestamp}.jsonl`);
  }

  /** Append a single action log */
  log(entry: ActionLog): void {
    this.logs.push(entry);
    appendFileSync(this.sessionFile, JSON.stringify(entry) + '\n');
  }

  /** Get all logs from this session */
  getLogs(): ActionLog[] {
    return this.logs;
  }

  /** Generate a human-readable report from family states */
  generateReport(familyStates: FamilyState[], startedAt: Date, familyConfigs?: FamilyConfig[]): SimulationReport {
    const now = new Date();
    const durationMs = now.getTime() - startedAt.getTime();
    const duration = this.formatDuration(durationMs);

    const families: FamilyReport[] = familyStates.map((state) => this.buildFamilyReport(state));
    const summary = this.buildSummary(families);

    const report: SimulationReport = {
      generatedAt: now.toISOString(),
      duration,
      families,
      summary,
    };

    // Score discoverability if family configs provided
    if (familyConfigs && this.logs.length > 0) {
      const scorer = new DiscoverabilityScorer();
      report.discoverability = scorer.score(this.logs, familyConfigs, familyStates);
    }

    // Write report to file
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const reportPath = join(this.logDir, `report-${ts}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Write LLM-readable diagnosis file
    const diagnosisPath = join(this.logDir, `diagnosis-${ts}.md`);
    writeFileSync(diagnosisPath, this.buildDiagnosis(report));

    // Write session manifest — full NPC decision lineage for UX analysis
    const manifestPath = join(this.logDir, `manifest-${ts}.json`);
    writeFileSync(manifestPath, JSON.stringify(this.buildManifest(), null, 2));

    return report;
  }

  // ─── LLM-Readable Diagnosis ─────────────────────────────────────

  private buildDiagnosis(report: SimulationReport): string {
    const lines: string[] = [];

    lines.push('# Truman Diagnosis Report');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Duration: ${report.duration} | Actions: ${report.summary.totalActions} | Success: ${(report.summary.overallSuccessRate * 100).toFixed(0)}%`);
    lines.push('');

    // Deduplicate failures by (action, HTTP status, request signature)
    const failureGroups = new Map<string, {
      action: string;
      httpStatus: string;
      count: number;
      affectedNPCs: Set<string>;
      sampleRequests: { params: Record<string, unknown>; responseBody: unknown }[];
    }>();

    for (const log of this.logs) {
      if (log.result.success) continue;
      const key = `${log.action}:${log.result.error ?? 'unknown'}`;
      const group = failureGroups.get(key) ?? {
        action: log.action,
        httpStatus: log.result.error ?? 'unknown',
        count: 0,
        affectedNPCs: new Set(),
        sampleRequests: [],
      };
      group.count++;
      group.affectedNPCs.add(`${log.memberName} (${log.memberRole})`);
      if (group.sampleRequests.length < 3) {
        group.sampleRequests.push({
          params: log.decision.params,
          responseBody: (log.result as any).response ?? null,
        });
      }
      failureGroups.set(key, group);
    }

    if (failureGroups.size === 0) {
      lines.push('## No failures detected');
      lines.push('All NPC actions completed successfully.');
      return lines.join('\n');
    }

    // Sort by count desc
    const sorted = [...failureGroups.values()].sort((a, b) => b.count - a.count);

    lines.push(`## ${sorted.length} Failure Types Found`);
    lines.push('');

    for (const group of sorted) {
      lines.push(`### ${group.action} → ${group.httpStatus} (${group.count}x)`);
      lines.push(`Affected: ${[...group.affectedNPCs].join(', ')}`);
      lines.push('');

      for (let i = 0; i < group.sampleRequests.length; i++) {
        const sample = group.sampleRequests[i];
        lines.push(`**Sample ${i + 1}:**`);
        lines.push('```json');
        lines.push(`// Request params sent by NPC`);
        lines.push(JSON.stringify(sample.params, null, 2));
        lines.push('```');
        if (sample.responseBody) {
          lines.push('```json');
          lines.push(`// Server response`);
          const body = typeof sample.responseBody === 'string'
            ? sample.responseBody
            : JSON.stringify(sample.responseBody, null, 2);
          // Truncate very long responses
          lines.push(body.length > 500 ? body.slice(0, 500) + '\n// ... truncated' : body);
          lines.push('```');
        }
        lines.push('');
      }
    }

    // Action coverage
    lines.push('## Action Coverage');
    const actionMap = new Map<string, { total: number; ok: number }>();
    for (const log of this.logs) {
      const prev = actionMap.get(log.action) ?? { total: 0, ok: 0 };
      prev.total++;
      if (log.result.success) prev.ok++;
      actionMap.set(log.action, prev);
    }
    for (const [action, stats] of [...actionMap.entries()].sort((a, b) => b[1].total - a[1].total)) {
      const rate = stats.total > 0 ? Math.round((stats.ok / stats.total) * 100) : 100;
      const icon = rate === 100 ? 'PASS' : rate === 0 ? 'FAIL' : 'PARTIAL';
      lines.push(`- [${icon}] ${action}: ${stats.ok}/${stats.total} (${rate}%)`);
    }

    return lines.join('\n');
  }

  // ─── Session Manifest — Full NPC Decision Lineage ──────────────

  private buildManifest(): object {
    // Group logs by NPC, preserving full decision chain
    const npcs = new Map<string, {
      memberId: string;
      memberName: string;
      memberRole: string;
      familyId: string;
      familyName: string;
      sessions: Map<string, object[]>;
    }>();

    for (const log of this.logs) {
      if (!npcs.has(log.memberId)) {
        npcs.set(log.memberId, {
          memberId: log.memberId,
          memberName: log.memberName,
          memberRole: log.memberRole,
          familyId: log.familyId,
          familyName: log.familyName,
          sessions: new Map(),
        });
      }
      const npc = npcs.get(log.memberId)!;
      if (!npc.sessions.has(log.sessionId)) npc.sessions.set(log.sessionId, []);

      npc.sessions.get(log.sessionId)!.push({
        step: log.actionIndex,
        timestamp: log.timestamp,
        action: log.action,
        params: log.decision.params,
        reasoning: log.decision.reasoning,
        mood: log.decision.mood,
        frustration: log.decision.frustration,
        wantsToContinue: log.decision.wantsToContinue,
        result: {
          success: log.result.success,
          statusCode: log.result.statusCode,
          duration: log.result.duration,
          // Include response snippet for context (truncated)
          responsePreview: typeof log.result.response === 'string'
            ? log.result.response.slice(0, 200)
            : JSON.stringify(log.result.response ?? '').slice(0, 200),
        },
        screenshot: `${String(log.actionIndex).padStart(3, '0')}-${log.memberId}-${log.action}.png`,
      });
    }

    // Convert to serializable format
    const npcList = [...npcs.values()].map((npc) => ({
      memberId: npc.memberId,
      memberName: npc.memberName,
      role: npc.memberRole,
      family: { id: npc.familyId, name: npc.familyName },
      totalActions: [...npc.sessions.values()].reduce((s, a) => s + a.length, 0),
      sessions: [...npc.sessions.entries()].map(([sessionId, actions]) => ({
        sessionId,
        actionCount: actions.length,
        decisionChain: actions,
      })),
    }));

    return {
      generatedAt: new Date().toISOString(),
      screenshotDir: '.truman/screenshots',
      totalNPCs: npcList.length,
      totalActions: this.logs.length,
      npcs: npcList,
    };
  }

  /** Load logs from a previous session file */
  static loadSession(filePath: string): ActionLog[] {
    const raw = readFileSync(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ActionLog);
  }

  private buildFamilyReport(state: FamilyState): FamilyReport {
    const members: MemberReport[] = Object.values(state.members).map((m) => ({
      memberId: m.memberId,
      memberName: m.memberId, // Name not stored in state, resolved at report time
      role: 'parent' as const, // Resolved at report time
      sessionsRun: m.totalSessions,
      actionsPerformed: m.totalActions,
      successRate: m.totalActions > 0 ? 1 - m.issues.length / m.totalActions : 1,
      avgFrustration: m.avgFrustration,
      discoveredFeatures: m.discoveredFeatures,
      blockedFeatures: this.findBlockedFeatures(m.issues),
      topIssues: m.issues.slice(0, 5).map((i) => `${i.action}: ${i.error}`),
    }));

    const allIssues = Object.values(state.members).flatMap((m) => m.issues);

    return {
      familyId: state.familyId,
      familyName: state.familyId,
      lifestyle: 'structured',
      members,
      issues: allIssues.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 20),
    };
  }

  private buildSummary(families: FamilyReport[]): ReportSummary {
    const allMembers = families.flatMap((f) => f.members);
    const allIssues = families.flatMap((f) => f.issues);
    const totalActions = allMembers.reduce((sum, m) => sum + m.actionsPerformed, 0);
    const totalSuccesses = allMembers.reduce(
      (sum, m) => sum + Math.round(m.actionsPerformed * m.successRate),
      0,
    );

    // Find critical issues (high frustration)
    const criticalIssues = allIssues.filter((i) => i.frustration >= 0.7);

    // Find UX blockers (features multiple members failed at)
    const featureFailures = new Map<string, Set<string>>();
    for (const family of families) {
      for (const member of family.members) {
        for (const issue of member.topIssues) {
          const feature = issue.split(':')[0].trim();
          if (!featureFailures.has(feature)) featureFailures.set(feature, new Set());
          featureFailures.get(feature)!.add(member.memberId);
        }
      }
    }

    const uxBlockers = Array.from(featureFailures.entries())
      .filter(([_, members]) => members.size >= 2)
      .map(([feature, members]) => ({
        feature,
        affectedMembers: Array.from(members),
        description: `${members.size} members had issues with "${feature}"`,
      }));

    return {
      totalFamilies: families.length,
      totalMembers: allMembers.length,
      totalActions,
      overallSuccessRate: totalActions > 0 ? totalSuccesses / totalActions : 1,
      criticalIssues,
      uxBlockers,
    };
  }

  private findBlockedFeatures(issues: IssueRecord[]): string[] {
    const failCounts = new Map<string, number>();
    for (const issue of issues) {
      failCounts.set(issue.action, (failCounts.get(issue.action) ?? 0) + 1);
    }
    // Feature is "blocked" if it failed 3+ times
    return Array.from(failCounts.entries())
      .filter(([_, count]) => count >= 3)
      .map(([action]) => action);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
