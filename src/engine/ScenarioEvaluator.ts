import type { SuccessCriterion, ScenarioResult, ScenarioConfig } from '../types.js';

export interface SessionHistoryEntry {
  action: string;
  params: Record<string, unknown>;
  success: boolean;
  responseSnippet: string;
  goal?: string;
}

/**
 * Evaluates scenario success criteria against the session history.
 * Called after a scenario session completes to determine if the NPC
 * achieved its goal.
 */
export class ScenarioEvaluator {
  evaluate(
    scenario: ScenarioConfig,
    history: SessionHistoryEntry[],
    startTime: number,
  ): ScenarioResult {
    const criteriaResults = scenario.success_criteria.map((criterion) => {
      const result = this.evaluateCriterion(criterion, history);
      return { criterion, ...result };
    });

    const allPassed = criteriaResults.every((r) => r.passed);

    return {
      scenarioId: scenario.id,
      actor: scenario.actor,
      goal: scenario.goal,
      success: allPassed,
      criteriaResults,
      actionsTaken: history.map((h) => h.action),
      totalActions: history.length,
      duration: Date.now() - startTime,
    };
  }

  private evaluateCriterion(
    criterion: SuccessCriterion,
    history: SessionHistoryEntry[],
  ): { passed: boolean; detail: string } {
    switch (criterion.type) {
      case 'action_chain':
        return this.evalActionChain(criterion.actions, history);
      case 'action_performed':
        return this.evalActionPerformed(criterion.action, criterion.minTimes ?? 1, history);
      case 'response_matches':
        return this.evalResponseMatches(criterion.action, criterion.pattern, history);
      default:
        return { passed: false, detail: `Unknown criterion type: ${(criterion as any).type}` };
    }
  }

  /**
   * Check that all specified actions appear in order (not necessarily consecutive).
   * e.g. [check-briefing, view-tasks] passes if briefing happens before view-tasks,
   * even with other actions in between.
   */
  private evalActionChain(
    expectedActions: string[],
    history: SessionHistoryEntry[],
  ): { passed: boolean; detail: string } {
    const successfulActions = history.filter((h) => h.success).map((h) => h.action);
    let searchIdx = 0;
    const found: string[] = [];

    for (const expected of expectedActions) {
      const idx = successfulActions.indexOf(expected, searchIdx);
      if (idx === -1) {
        return {
          passed: false,
          detail: `Chain broken: "${expected}" not found after position ${searchIdx}. Found: [${found.join(' → ')}]`,
        };
      }
      found.push(expected);
      searchIdx = idx + 1;
    }

    return { passed: true, detail: `Chain complete: ${found.join(' → ')}` };
  }

  /**
   * Check that an action was performed at least N times successfully.
   */
  private evalActionPerformed(
    action: string,
    minTimes: number,
    history: SessionHistoryEntry[],
  ): { passed: boolean; detail: string } {
    const count = history.filter((h) => h.action === action && h.success).length;
    if (count >= minTimes) {
      return { passed: true, detail: `"${action}" performed ${count}x (required: ${minTimes})` };
    }
    return { passed: false, detail: `"${action}" performed ${count}x (required: ${minTimes})` };
  }

  /**
   * Check that a specific action's response matches a regex pattern.
   * Useful for verifying content creation (e.g. task title contains "lekarz").
   */
  private evalResponseMatches(
    action: string,
    pattern: string,
    history: SessionHistoryEntry[],
  ): { passed: boolean; detail: string } {
    const regex = new RegExp(pattern, 'i');
    const matching = history.filter(
      (h) => h.action === action && h.success && regex.test(h.responseSnippet),
    );

    if (matching.length > 0) {
      return { passed: true, detail: `"${action}" response matched /${pattern}/i` };
    }

    const attempts = history.filter((h) => h.action === action && h.success);
    if (attempts.length === 0) {
      return { passed: false, detail: `"${action}" was never performed successfully` };
    }
    return {
      passed: false,
      detail: `"${action}" performed ${attempts.length}x but no response matched /${pattern}/i`,
    };
  }
}
