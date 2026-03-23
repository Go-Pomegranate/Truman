import type {
  ActionLog,
  FamilyConfig,
  FamilyState,
  DiscoverabilityReport,
  FeatureDiscovery,
} from '../types.js';

/**
 * Derive feature categories from action names.
 * Uses the action's category if available from logs, otherwise extracts
 * a category from the action name (e.g., "manage-tasks" → "tasks").
 */
function deriveActionFeature(actionName: string): string {
  // Strip common prefixes to extract feature name
  const prefixes = ['manage-', 'view-', 'create-', 'complete-', 'delete-', 'update-', 'check-', 'list-', 'add-'];
  for (const prefix of prefixes) {
    if (actionName.startsWith(prefix)) return actionName.slice(prefix.length);
  }
  return actionName;
}

function buildFeatureMaps(logs: ActionLog[]): { actionToFeature: Record<string, string>; allFeatures: string[] } {
  const actionToFeature: Record<string, string> = {};
  for (const log of logs) {
    if (!actionToFeature[log.action]) {
      actionToFeature[log.action] = deriveActionFeature(log.action);
    }
  }
  const allFeatures = [...new Set(Object.values(actionToFeature))];
  return { actionToFeature, allFeatures };
}

/**
 * Scores how naturally NPCs discover features in the app.
 * Measures organic discovery, briefing→action correlation, and empty state handling.
 */
export class DiscoverabilityScorer {
  score(
    logs: ActionLog[],
    families: FamilyConfig[],
    _familyStates: FamilyState[],
  ): DiscoverabilityReport {
    const { allFeatures } = buildFeatureMaps(logs);
    const featureBreakdown = this.scoreFeatureDiscovery(logs, families);
    const briefingCorrelation = this.scoreActionCorrelation(logs);
    const emptyStateReactions = this.scoreEmptyStateHandling(logs);

    // Weighted overall score
    const discoveryRate = allFeatures.length > 0
      ? featureBreakdown.filter((f) => f.discovered).length / allFeatures.length
      : 0;
    const organicBonus = featureBreakdown.filter((f) => f.discovered && f.organic).length / Math.max(1, featureBreakdown.filter((f) => f.discovered).length);
    const emptyCreateRate = emptyStateReactions.length > 0
      ? emptyStateReactions.filter((e) => e.reaction === 'created').length / emptyStateReactions.length
      : 0.5; // neutral if no empty states

    const overallScore = Math.round(
      discoveryRate * 40 +
      organicBonus * 20 +
      briefingCorrelation * 20 +
      emptyCreateRate * 20,
    );

    return { overallScore, featureBreakdown, briefingCorrelation, emptyStateReactions };
  }

  private scoreFeatureDiscovery(
    logs: ActionLog[],
    families: FamilyConfig[],
  ): FeatureDiscovery[] {
    const { actionToFeature, allFeatures } = buildFeatureMaps(logs);

    // Build a set of scheduled features per member
    const scheduledFeatures = new Map<string, Set<string>>();
    for (const family of families) {
      for (const member of family.members) {
        const scheduled = new Set<string>();
        for (const entry of member.schedule) {
          const feature = actionToFeature[entry.action] ?? deriveActionFeature(entry.action);
          if (feature) scheduled.add(feature);
        }
        scheduledFeatures.set(member.id, scheduled);
      }
    }

    // Track discovery per feature
    const discovery = new Map<string, { discoveredBy: Set<string>; firstStep: Map<string, number>; organic: boolean }>();

    for (const feature of allFeatures) {
      discovery.set(feature, { discoveredBy: new Set(), firstStep: new Map(), organic: false });
    }

    // Track per-member action count to calculate steps
    const memberActionCount = new Map<string, number>();

    for (const log of logs) {
      if (!log.result.success) continue;

      const feature = actionToFeature[log.action];
      if (!feature) continue;

      const count = (memberActionCount.get(log.memberId) ?? 0) + 1;
      memberActionCount.set(log.memberId, count);

      const d = discovery.get(feature)!;
      d.discoveredBy.add(log.memberId);

      if (!d.firstStep.has(log.memberId)) {
        d.firstStep.set(log.memberId, count);
      }
    }

    return allFeatures.map((feature): FeatureDiscovery => {
      const d = discovery.get(feature)!;
      const discoveredBy = [...d.discoveredBy];
      const discovered = discoveredBy.length > 0;

      // Calculate avg steps to discover
      const steps = [...d.firstStep.values()];
      const avgSteps = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : null;

      // Organic = at least one discoverer didn't have this in their schedule
      const organic = discoveredBy.some((memberId) => {
        const scheduled = scheduledFeatures.get(memberId);
        return !scheduled?.has(feature);
      });

      return {
        feature,
        discovered,
        stepsToDiscover: avgSteps ? Math.round(avgSteps * 10) / 10 : null,
        discoveredBy,
        organic,
      };
    });
  }

  /**
   * Scores how well first actions in a session correlate with follow-up actions.
   * Measures whether personas take logical action sequences (read → act pattern).
   */
  private scoreActionCorrelation(logs: ActionLog[]): number {
    // Group logs by session
    const sessions = new Map<string, ActionLog[]>();
    for (const log of logs) {
      const key = log.sessionId;
      if (!sessions.has(key)) sessions.set(key, []);
      sessions.get(key)!.push(log);
    }

    let sessionsWithMultipleActions = 0;
    let sessionsWithVariety = 0;

    for (const [, sessionLogs] of sessions) {
      if (sessionLogs.length < 2) continue;
      sessionsWithMultipleActions++;

      // Check if the session has action variety (not just repeating one action)
      const uniqueActions = new Set(sessionLogs.map((l) => l.action));
      if (uniqueActions.size >= 2) sessionsWithVariety++;
    }

    return sessionsWithMultipleActions > 0 ? sessionsWithVariety / sessionsWithMultipleActions : 0;
  }

  private scoreEmptyStateHandling(
    logs: ActionLog[],
  ): { action: string; member: string; reaction: 'created' | 'frustrated' | 'left' }[] {
    const results: { action: string; member: string; reaction: 'created' | 'frustrated' | 'left' }[] = [];

    // Group by session
    const sessions = new Map<string, ActionLog[]>();
    for (const log of logs) {
      if (!sessions.has(log.sessionId)) sessions.set(log.sessionId, []);
      sessions.get(log.sessionId)!.push(log);
    }

    // Detect empty state: GET action returns "0 items" or empty array
    const getActions = new Set(['view-tasks', 'manage-calendar', 'manage-shopping', 'manage-quests', 'manage-meals']);
    const createCounterparts: Record<string, string> = {
      'view-tasks': 'manage-tasks',
      'manage-calendar': 'create-event',
      'manage-shopping': 'manage-shopping', // same action for POST
      'manage-quests': 'manage-quests',
      'manage-meals': 'manage-meals',
    };

    for (const [, sessionLogs] of sessions) {
      const sorted = sessionLogs.sort((a, b) => a.actionIndex - b.actionIndex);

      for (let i = 0; i < sorted.length; i++) {
        const log = sorted[i];
        if (!getActions.has(log.action) || !log.result.success) continue;

        // Check if response indicates empty state
        const resp = JSON.stringify(log.result.response ?? '');
        const isEmpty = resp.includes('"open":[]') || resp === '[]' || resp.includes('0 items');
        if (!isEmpty) continue;

        // What did the NPC do after seeing an empty state?
        const createAction = createCounterparts[log.action];
        const nextActions = sorted.slice(i + 1, i + 4);
        const created = nextActions.some((a) => a.action === createAction && a.result.success);
        const frustrated = nextActions.some((a) => (a.decision.frustration ?? 0) > 0.3);
        const left = nextActions.length === 0 || (nextActions[0]?.decision.wantsToContinue === false);

        results.push({
          action: log.action,
          member: log.memberName,
          reaction: created ? 'created' : frustrated ? 'frustrated' : left ? 'left' : 'created',
        });
      }
    }

    return results;
  }
}
