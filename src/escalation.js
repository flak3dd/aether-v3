import { config } from "./config.js";
import { bus } from "./events.js";

/**
 * PRINCIPLE: failures are routed, not log-stuffed.
 * Ladder: retry → fix → rollback → replan → human.
 * Each rung has a turn budget (config.budgets.ladder). Burning a rung's
 * budget with zero burn-down movement auto-escalates to the next rung.
 * The ladder resets whenever the burn-down actually improves.
 */
const RUNGS = ["retry", "fix", "rollback", "replan", "human"];

export class Escalation {
  constructor() {
    this.rungIndex = 0;
    this.turnsOnRung = 0;
  }

  get rung() { return RUNGS[this.rungIndex]; }

  /**
   * Heuristic failure classifier. Deliberately dumb — string matching gets
   * surprisingly far, and the foreman can override via the ledger.
   * EXTENSION POINT: replace with a cheap model call for ambiguous logs.
   */
  static classify(log = "") {
    const l = log.toLowerCase();
    if (/enoent|command not found|econnrefused|etimedout|enetunreach|permission denied/.test(l)) return "environment";
    if (/timeout|flaky|intermittent|socket hang up/.test(l)) return "flaky";
    if (/assert|expected .* received|test failed|typeerror|referenceerror|syntaxerror/.test(l)) return "logic";
    if (/cannot|impossible|conflict|incompatible/.test(l)) return "design";
    return "unknown";
  }

  /** Call once per turn with the recent burn-down delta. Returns directive. */
  tick(recentDelta) {
    if (recentDelta > 0) {
      this.rungIndex = 0;
      this.turnsOnRung = 0;
      return { rung: this.rung, escalated: false };
    }
    this.turnsOnRung++;
    const budget = config.budgets.ladder[this.rung] ?? Infinity;
    if (this.turnsOnRung > budget && this.rungIndex < RUNGS.length - 1) {
      this.rungIndex++;
      this.turnsOnRung = 0;
      bus.emit("escalation:rung", { rung: this.rung, reason: "burn-down flat past rung budget" });
      return { rung: this.rung, escalated: true };
    }
    return { rung: this.rung, escalated: false };
  }

  /** Directive text injected into the foreman's context for the current rung. */
  directive() {
    return {
      retry: "Strategy: RETRY. Re-run the failing path once; capture exact errors.",
      fix: "Strategy: TARGETED FIX. Pin the failing check's output in your reasoning; change the minimum code to address the specific error. Do not refactor.",
      rollback: "Strategy: ROLLBACK. The current approach is compounding errors. Call rollback_to_green, record the dead approach in the ledger (failedApproaches), then take a different path.",
      replan: "Strategy: RE-PLAN. Step back from code. Re-read the ledger and DoD; restate the plan for the failing component from scratch. Consider amending the DoD (with justification) if a check is mis-specified.",
      human: "Strategy: ASK HUMAN. You have exhausted autonomous strategies for this failure. Use ask_human with a crisp question and concrete options, then continue with non-blocked work.",
    }[this.rung];
  }
}
