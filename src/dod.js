import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { bus } from "./events.js";

/**
 * PRINCIPLE 2: verification is continuous.
 * The DoD is a versioned artifact of *executable* checks. A subset runs after
 * every mutating turn; the full set runs on completion claims. The burn-down
 * (passing/total over time) is the system's single progress metric and the
 * input to thrash detection.
 *
 * Check kinds:
 *   file_exists : { path }
 *   shell       : { cmd }            — passes iff exit code 0
 *   behavior    : { cmd, expect }    — passes iff stdout contains `expect`
 *
 * Amendment rules:
 *   - foreman may ADD checks, or MODIFY with a logged justification
 *   - foreman may NOT remove checks; scope reduction requires human sign-off
 *   - critic may only ADD (enforced in critic.js by tool whitelist)
 */
export class DoD {
  constructor(workspaceDir, sandbox) {
    this.path = join(workspaceDir, ".aether", "dod.json");
    this.workspaceDir = workspaceDir;
    this.sandbox = sandbox;
  }

  read() {
    if (!existsSync(this.path)) return { version: 0, checks: [], amendments: [], burndown: [] };
    return JSON.parse(readFileSync(this.path, "utf8"));
  }

  #write(d) { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(d, null, 2)); }

  commit(checks) {
    const d = { version: 1, checks: checks.map((c, i) => ({ id: c.id || `dod-${i + 1}`, status: "pending", addedBy: "foreman", ...c })), amendments: [], burndown: [] };
    this.#write(d);
    return d;
  }

  addCheck(check, addedBy, justification) {
    const d = this.read();
    const id = check.id || `dod-${d.checks.length + 1}`;
    d.checks.push({ id, status: "pending", addedBy, ...check });
    d.amendments.push({ at: Date.now(), kind: "add", id, by: addedBy, justification });
    d.version++;
    this.#write(d);
    return id;
  }

  amendCheck(id, patch, justification) {
    const d = this.read();
    const c = d.checks.find((c) => c.id === id);
    if (!c) throw new Error(`No such check: ${id}`);
    if (patch.remove) throw new Error("Checks cannot be removed by the foreman; queue a human question for scope reduction.");
    Object.assign(c, patch);
    d.amendments.push({ at: Date.now(), kind: "amend", id, by: "foreman", justification });
    d.version++;
    this.#write(d);
  }

  async #runOne(c) {
    try {
      if (c.kind === "file_exists") return existsSync(join(this.workspaceDir, c.path));
      if (c.kind === "shell") return (await this.sandbox.run(c.cmd)).code === 0;
      if (c.kind === "behavior") {
        const r = await this.sandbox.run(c.cmd);
        return r.code === 0 && r.stdout.includes(c.expect);
      }
      return false;
    } catch { return false; }
  }

  /**
   * Run checks. `filter` lets the foreman run only the checks plausibly
   * affected by the last write (cheap incremental verification); pass
   * nothing to run everything (completion claims, critic pass).
   */
  async run(turn, filter = null) {
    const d = this.read();
    const targets = filter ? d.checks.filter(filter) : d.checks;
    const regressions = [];
    for (const c of targets) {
      const before = c.status;
      c.status = (await this.#runOne(c)) ? "pass" : "fail";
      bus.emit("dod:check", { id: c.id, status: c.status });
      // EXTENSION POINT: a pass→fail transition here is a regression —
      // hand RepoState.bisect() the check command to find the breaking turn.
      if (before === "pass" && c.status === "fail") {
        bus.emit("dod:regression", { id: c.id });
        regressions.push(c);
      }
    }
    const passing = d.checks.filter((c) => c.status === "pass").length;
    d.burndown.push({ turn, at: Date.now(), passing, total: d.checks.length });
    this.#write(d);
    bus.emit("dod:burndown", { passing, total: d.checks.length });
    return { passing, total: d.checks.length, allGreen: passing === d.checks.length && d.checks.length > 0, regressions };
  }

  /** Burn-down delta over the last `window` samples — thrash detector input. */
  recentDelta(window) {
    const b = this.read().burndown;
    if (b.length < 2) return Infinity; // not enough data to call it thrash
    const slice = b.slice(-window);
    return slice[slice.length - 1].passing - slice[0].passing;
  }

  toPrompt() {
    const d = this.read();
    if (!d.checks.length) return "(no DoD committed yet)";
    return d.checks.map((c) => `- [${c.status === "pass" ? "x" : " "}] ${c.id} (${c.kind}${c.addedBy === "critic" ? ", critic" : ""}): ${c.cmd || c.path}${c.expect ? ` ⇒ "${c.expect}"` : ""}`).join("\n");
  }
}
