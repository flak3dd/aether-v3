import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The Project Ledger replaces v2's freeform scratchpad with a schema:
 * the Foreman's context is rebuilt every turn from repo state + this file,
 * so anything not recorded here is forgotten by design. That pressure is
 * the point — it forces durable knowledge into a compact, structured form.
 */
const EMPTY = {
  decisions: [],        // { id, turn, decision, rationale, source: "foreman"|"human" }
  constraints: [],      // { id, turn, constraint, discoveredVia }
  failedApproaches: [], // { id, turn, approach, whyItFailed }  ← thrash vaccine
  openQuestions: [],    // { id, turn, question, blockedPaths: [] }
};

export class Ledger {
  constructor(workspaceDir) {
    this.path = join(workspaceDir, ".aether", "ledger.json");
  }

  read() {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    return JSON.parse(readFileSync(this.path, "utf8"));
  }

  #write(data) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  append(section, entry) {
    const data = this.read();
    if (!(section in data)) throw new Error(`Unknown ledger section: ${section}`);
    const id = `${section.slice(0, 3)}-${data[section].length + 1}`;
    data[section].push({ id, ...entry });
    this.#write(data);
    return id;
  }

  resolveQuestion(id) {
    const data = this.read();
    data.openQuestions = data.openQuestions.filter((q) => q.id !== id);
    this.#write(data);
  }

  /** Render for prompt injection — compact markdown, newest first per section. */
  toPrompt(maxPerSection = 12) {
    const d = this.read();
    const fmt = (title, rows, f) =>
      rows.length ? `### ${title}\n${rows.slice(-maxPerSection).map(f).join("\n")}` : "";
    return [
      fmt("Decisions", d.decisions, (r) => `- [${r.id}|t${r.turn}|${r.source}] ${r.decision} — ${r.rationale}`),
      fmt("Constraints discovered", d.constraints, (r) => `- [${r.id}|t${r.turn}] ${r.constraint}`),
      fmt("Failed approaches (do NOT retry these)", d.failedApproaches, (r) => `- [${r.id}|t${r.turn}] ${r.approach} → ${r.whyItFailed}`),
      fmt("Open questions (pending human)", d.openQuestions, (r) => `- [${r.id}] ${r.question}`),
    ].filter(Boolean).join("\n\n") || "(ledger empty)";
  }
}
