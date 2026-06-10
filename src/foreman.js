import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { bus } from "./events.js";
import { modelTurn, toolResultsMessage } from "./llm.js";
import { RepoState } from "./repoState.js";
import { Ledger } from "./ledger.js";
import { DoD } from "./dod.js";
import { Sandbox } from "./sandbox.js";
import { Escalation } from "./escalation.js";
import { HumanQueue } from "./humanQueue.js";
import { SkillsLibrary } from "./skillsLib.js";
import { TOOL_SCHEMAS, LeaseRegistry, makeExecutor } from "./tools/index.js";
import { runWorker } from "./workers.js";
import { runCritic } from "./critic.js";

const FOREMAN_SYSTEM = `You are the Aether Foreman: the single locus of intent for this build.
Operating principles:
- The repo is the mind. Anything worth remembering goes in the ledger (ledger_append) or in code — your transcript is reconstructed every turn and old turns are forgotten.
- Verification is continuous. Work toward turning DoD checks green; never claim completion speculatively.
- Agents are ephemeral. Delegate bounded, parallelizable subtasks via spawn_worker with precise file leases; you own integration.
- Never write placeholder code. Never retry an approach listed under "Failed approaches".
- Follow the current escalation directive when the burn-down is stalled.
- Questions for the human go through ask_human (non-blocking); proceed with non-dependent work.
End your turn with a one-line summary starting "SUMMARY:" describing what changed.`;

const DOD_SYSTEM = `You translate a software build goal into a Definition of Done: a JSON array of executable checks.
Check kinds: {"kind":"file_exists","path":...} | {"kind":"shell","cmd":...} | {"kind":"behavior","cmd":...,"expect":...}.
Rules: 5–15 checks; each cheap and unambiguous; cover existence, tests passing, and at least one demonstrated behavior. Reply with ONLY the JSON array.`;

export class Foreman {
  constructor(goal) {
    this.goal = goal;
    this.turn = 0;
    this.recentSummaries = []; // rolling window — the only transcript residue

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.workspaceDir = join(config.paths.buildsRoot, `build-${stamp}`);
    mkdirSync(join(this.workspaceDir, ".aether"), { recursive: true });

    this.repo = new RepoState(this.workspaceDir);
    this.ledger = new Ledger(this.workspaceDir);
    this.sandbox = new Sandbox(this.workspaceDir);
    this.dod = new DoD(this.workspaceDir, this.sandbox);
    this.leases = new LeaseRegistry();
    this.humanQueue = new HumanQueue();
    this.escalation = new Escalation();
    this.skills = new SkillsLibrary();

    this.ctx = {
      workspaceDir: this.workspaceDir,
      sandbox: this.sandbox, ledger: this.ledger, dod: this.dod,
      repo: this.repo, leases: this.leases, humanQueue: this.humanQueue,
      turn: () => this.turn,
      spawnWorker: (input) => runWorker(input, this.ctx),
    };
    this.execute = makeExecutor(this.ctx, "foreman");
  }

  /** PRINCIPLE 1 in action: context is rebuilt, not accumulated. */
  buildContext(extra = "") {
    const answers = this.humanQueue.drainAnswers();
    for (const a of answers) {
      this.ledger.append("decisions", { turn: this.turn, decision: a.answer, rationale: `human answer to ${a.id}`, source: "human" });
      this.ledger.resolveQuestion(a.id);
    }
    return [
      `# Build goal\n${this.goal}`,
      `# Definition of Done (v${this.dod.read().version})\n${this.dod.toPrompt()}`,
      `# Project ledger\n${this.ledger.toPrompt()}`,
      `# Recent commits\n${this.repo.log(8)}`,
      `# Recent turn summaries\n${this.recentSummaries.slice(-8).join("\n") || "(first turn)"}`,
      `# Current directive\n${this.escalation.directive()}`,
      extra,
    ].filter(Boolean).join("\n\n");
  }

  async commitDoD() {
    const priorSkills = this.skills.retrieve(this.goal);
    const res = await modelTurn({
      model: config.models.foreman,
      system: DOD_SYSTEM,
      messages: [{ role: "user", content: `Goal: ${this.goal}${priorSkills.length ? `\n\nLessons from prior builds:\n${priorSkills.join("\n---\n")}` : ""}` }],
      maxTokens: 2000,
    });
    const checks = JSON.parse(res.text.replace(/```json|```/g, "").trim());
    this.dod.commit(checks);
    if (priorSkills.length) {
      this.ledger.append("constraints", { turn: 0, constraint: `Prior-build lessons loaded (${priorSkills.length})`, discoveredVia: "skills-library" });
    }
    console.log(`\nDoD committed — ${checks.length} checks:\n${this.dod.toPrompt()}`);
  }

  processRegressions(regressions) {
    if (!regressions || !regressions.length) return;
    for (const check of regressions) {
      console.log(`\n[Bisect] Regression detected on check "${check.id}". Running automated bisect...`);
      const result = this.repo.bisect(check);
      if (result.ok) {
        console.log(`[Bisect] Pinpointed breaking commit: ${result.hash} (${result.details})`);
        this.ledger.append("failedApproaches", {
          turn: this.turn,
          approach: `Changes introducing commit ${result.hash}`,
          whyItFailed: `Regressed check ${check.id} (${check.cmd || check.path}). Bisect trace:\n${result.details}`
        });
        bus.emit("bisect:success", { checkId: check.id, hash: result.hash, details: result.details });
      } else {
        console.error(`[Bisect] Failed to pinpoint regression: ${result.error}`);
        bus.emit("bisect:fail", { checkId: check.id, error: result.error });
      }
    }
  }

  /** One foreman turn: context → inner tool loop → commit → incremental verify. */
  async runTurn(nudge = "") {
    this.turn++;
    console.log(`[Foreman] runTurn: Turn ${this.turn} starting.`);
    bus.emit("turn:start", this.turn);

    const messages = [{ role: "user", content: this.buildContext(nudge) }];
    let claim = null;

    for (let step = 0; step < 12; step++) { // inner tool-loop cap per turn
      console.log(`[Foreman] runTurn: Turn ${this.turn}, Step ${step} - calling modelTurn...`);
      const res = await modelTurn({ model: config.models.foreman, system: FOREMAN_SYSTEM, messages, tools: TOOL_SCHEMAS });
      console.log(`[Foreman] runTurn: Turn ${this.turn}, Step ${step} - modelTurn responded.`);
      messages.push({ role: "assistant", content: res.raw.content });

      if (!res.toolCalls.length) {
        const summary = (res.text.match(/SUMMARY:.*$/ms)?.[0] || res.text).slice(0, 300);
        this.recentSummaries.push(`t${this.turn}: ${summary}`);
        break;
      }

      const results = [];
      for (const call of res.toolCalls) {
        bus.emit("tool:call", { id: call.id, name: call.name, input: call.input, brief: call.input.path || call.input.cmd?.slice(0, 60) || "" });
        try {
          const out = await this.execute(call.name, call.input);
          let content;
          if (out?.__claimComplete) {
            claim = out;
            content = "completion claim registered — verification will run";
          } else {
            content = String(out);
          }
          results.push({ id: call.id, content });
          bus.emit("tool:result", { id: call.id, name: call.name, ok: true, output: content });
        } catch (e) {
          const content = `ERROR: ${e.message}`;
          results.push({ id: call.id, content, isError: true });
          bus.emit("tool:result", { id: call.id, name: call.name, ok: false, output: content });
        }
      }
      messages.push(toolResultsMessage(results));
      if (claim) break;
    }

    console.log(`[Foreman] runTurn: Turn ${this.turn} committing...`);
    this.repo.commitTurn(this.turn, this.recentSummaries.at(-1) || "work");
    console.log(`[Foreman] runTurn: Turn ${this.turn} running DoD...`);
    const status = await this.dod.run(this.turn);
    console.log(`[Foreman] runTurn: Turn ${this.turn} processing regressions...`);
    this.processRegressions(status.regressions);
    if (status.allGreen) this.repo.markGreen();
    return { claim, status };
  }

  async run() {
    console.log("[Foreman] Initializing repository...");
    this.repo.init();
    console.log("[Foreman] Committing DoD...");
    await this.commitDoD();
    console.log("[Foreman] Committing turn 0...");
    this.repo.commitTurn(0, "DoD committed");
    console.log("[Foreman] Starting turn loop...");

    let nudge = "";
    while (this.turn < config.budgets.maxTurns) {
      console.log(`[Foreman] Starting turn ${this.turn + 1}...`);
      const { claim, status } = await this.runTurn(nudge);
      console.log(`[Foreman] Turn ${this.turn} finished. Claim:`, claim, "Status:", status);
      nudge = "";

      if (claim || status.allGreen) {
        const full = await this.dod.run(this.turn); // full verification on claim
        this.processRegressions(full.regressions);
        if (!full.allGreen) {
          const failing = this.dod.read().checks.filter((c) => c.status !== "pass").map((c) => c.id).join(", ");
          nudge = `# Verification verdict\nCompletion claim REJECTED. Failing checks: ${failing}. Fix them.`;
          continue;
        }
        this.repo.markGreen();
        console.log("\nAll checks green — summoning the Critic…");
        const { added, verdict } = await runCritic(this.goal, this.ctx);
        if (added > 0) {
          nudge = `# Critic verdict\nThe Critic added ${added} new DoD check(s). The spec has expanded; satisfy it.\nCritic notes: ${verdict.slice(0, 500)}`;
          continue;
        }
        const note = await this.skills.distill(this.goal, this.ledger);
        if (note) console.log(`Distilled lessons → ${note}`);
        bus.emit("build:complete", {});
        return true;
      }

      // Thrash detection: burn-down slope drives the ladder.
      const { escalated } = this.escalation.tick(this.dod.recentDelta(config.budgets.thrashWindow));
      if (escalated) nudge = `# Escalation\n${this.escalation.directive()}`;

      await this.humanQueue.promptCli(); // between-turns chance to answer queued questions
    }

    bus.emit("build:failed", { reason: `turn budget (${config.budgets.maxTurns}) exhausted` });
    return false;
  }
}
