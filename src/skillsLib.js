import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { modelTurn } from "./llm.js";
import { config } from "./config.js";

/**
 * Cross-build memory: the only component that makes the system better over
 * time. After each build, the ledger's hard-won knowledge (constraints,
 * failed approaches) is distilled into a short skill note tagged by stack;
 * the next similar build starts with relevant notes injected.
 *
 * EXTENSION POINT: retrieval below is naive keyword overlap. Swap in
 * embeddings when the library outgrows it.
 */
export class SkillsLibrary {
  constructor(dir = config.paths.skillsLibrary) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** Retrieve up to `k` notes relevant to the goal (keyword overlap score). */
  retrieve(goal, k = 3) {
    const words = new Set(goal.toLowerCase().match(/[a-z][a-z0-9.+-]{2,}/g) || []);
    const scored = [];
    for (const f of existsSync(this.dir) ? readdirSync(this.dir) : []) {
      if (!f.endsWith(".md")) continue;
      const text = readFileSync(join(this.dir, f), "utf8");
      const tags = (text.match(/^tags:\s*(.+)$/m)?.[1] || "").toLowerCase().split(/[,\s]+/);
      const score = tags.filter((t) => words.has(t)).length;
      if (score > 0) scored.push({ f, score, text });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k).map((s) => s.text);
  }

  /** Distill a completed build's ledger into a skill note. */
  async distill(goal, ledger) {
    const body = ledger.toPrompt(50);
    if (body === "(ledger empty)") return null;
    const res = await modelTurn({
      model: config.models.foreman,
      system: "You distill build postmortems into terse, reusable skill notes for future agent builds.",
      messages: [{
        role: "user",
        content: `Goal: ${goal}\n\nLedger:\n${body}\n\nWrite a markdown note (<200 words) capturing only knowledge that would save a FUTURE similar build time: environment gotchas, library constraints, approaches to avoid. First line must be "tags: <space-separated stack keywords>". If nothing is reusable, reply exactly NONE.`,
      }],
      maxTokens: 600,
    });
    if (res.text.trim() === "NONE") return null;
    const file = join(this.dir, `skill-${Date.now()}.md`);
    writeFileSync(file, res.text.trim() + "\n");
    return file;
  }
}
