import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * PRINCIPLE 1: the repo is the mind.
 * Every mutating turn becomes a commit. The last fully-green DoD state is
 * tagged so the escalation ladder can roll back instead of patching forward
 * through a mess. The transcript is disposable; this is not.
 */
export class RepoState {
  constructor(workspaceDir) {
    this.dir = workspaceDir;
  }

  #git(...args) {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
  }

  init() {
    mkdirSync(this.dir, { recursive: true });
    this.#git("init", "-q");
    this.#git("config", "user.email", "foreman@aether.local");
    this.#git("config", "user.name", "Aether Foreman");
    // Engine state (.aether: ledger, DoD, burn-down) is deliberately
    // UNTRACKED: it must survive rollbacks — the failed approaches recorded
    // after a green checkpoint are exactly what rollback must not erase.
    writeFileSync(join(this.dir, ".gitignore"), ".aether/\nnode_modules/\n");
    // Empty root commit so rollback always has a floor.
    this.#git("commit", "--allow-empty", "-q", "-m", "aether: genesis");
  }

  /** Commit everything; returns short sha (or null if nothing changed). */
  commitTurn(turn, summary) {
    this.#git("add", "-A");
    const dirty = this.#git("status", "--porcelain");
    if (!dirty) return null;
    this.#git("commit", "-q", "-m", `turn ${turn}: ${summary || "work"}`);
    return this.#git("rev-parse", "--short", "HEAD");
  }

  /** Tag current HEAD as the last known fully-green state. */
  markGreen() {
    this.#git("tag", "-f", "aether-last-green");
  }

  hasGreen() {
    try { this.#git("rev-parse", "aether-last-green"); return true; }
    catch { return false; }
  }

  /** Hard rollback to last green checkpoint. Returns the sha rolled to. */
  rollbackToGreen() {
    this.#git("reset", "--hard", "-q", "aether-last-green");
    this.#git("clean", "-fdq", "-e", ".aether");
    return this.#git("rev-parse", "--short", "HEAD");
  }

  log(n = 10) {
    return this.#git("log", `-${n}`, "--oneline");
  }

  /**
   * Run git bisect to find the exact commit that broke the given check.
   */
  bisect(check) {
    if (!this.hasGreen()) {
      return { ok: false, error: "No green checkpoint ('aether-last-green') exists to bisect against." };
    }

    const runnerPath = join(this.dir, ".aether", "bisect-runner.js");
    const pkgPath = join(this.dir, ".aether", "package.json");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const sandboxPath = join(__dirname, "sandbox.js");

    // Write package.json and runner script
    writeFileSync(pkgPath, JSON.stringify({ type: "module" }));
    
    const runnerContent = `import { Sandbox } from "${sandboxPath}";
import { existsSync } from "node:fs";
import { join } from "node:path";

const check = ${JSON.stringify(check)};
const workspaceDir = "${this.dir.replace(/\\/g, "\\\\")}";

async function main() {
  try {
    if (check.kind === "file_exists") {
      const ok = existsSync(join(workspaceDir, check.path));
      process.exit(ok ? 0 : 1);
    }
    const sandbox = new Sandbox(workspaceDir);
    if (check.kind === "shell") {
      const r = await sandbox.run(check.cmd);
      process.exit(r.code === 0 ? 0 : 1);
    }
    if (check.kind === "behavior") {
      const r = await sandbox.run(check.cmd);
      const ok = r.code === 0 && r.stdout.includes(check.expect);
      process.exit(ok ? 0 : 1);
    }
    process.exit(1);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
main();
`;
    writeFileSync(runnerPath, runnerContent);

    let output = "";
    try {
      this.#git("bisect", "start");
      this.#git("bisect", "bad", "HEAD");
      this.#git("bisect", "good", "aether-last-green");
      output = this.#git("bisect", "run", "node", ".aether/bisect-runner.js");
    } catch (e) {
      output = e.stdout || e.message || String(e);
    } finally {
      try {
        this.#git("bisect", "reset");
      } catch {}
    }

    const match = output.match(/([0-9a-f]{7,40}) is the first bad commit/i);
    if (match) {
      const hash = match[1];
      try {
        const details = this.#git("show", "--oneline", hash);
        return { ok: true, hash, details, log: output };
      } catch {
        return { ok: true, hash, details: `Commit ${hash}`, log: output };
      }
    }

    return { ok: false, log: output, error: "Could not pinpoint the breaking commit." };
  }
}
