import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { config } from "./config.js";

/**
 * PRINCIPLE: run_shell is the real attack/blast surface, not the file tools.
 * Preferred mode runs every command in a disposable container with the
 * workspace mounted and no network by default. Host mode exists for dev
 * convenience and is loudly NOT isolation.
 *
 * EXTENSION POINTS:
 *  - per-build long-lived container instead of per-command (faster, keeps
 *    node_modules warm): docker create + docker exec
 *  - egress allowlist (npm registry only) via a proxy sidecar instead of
 *    the blunt --network none / bridge toggle below
 *  - microVM backend (firecracker/kata) behind the same .run() interface
 */
export class Sandbox {
  constructor(workspaceDir) {
    this.dir = resolve(workspaceDir);
    this.mode = config.sandbox.mode;
    if (this.mode === "docker" && !this.#dockerAvailable()) {
      console.warn("⚠ docker not available — falling back to HOST mode (no isolation).");
      this.mode = "host";
    }
    if (this.mode === "host") {
      console.warn("⚠ Sandbox mode: host. Commands run on your machine with your privileges.");
    }
  }

  #dockerAvailable() {
    try { execFileSync("docker", ["version"], { stdio: "ignore" }); return true; }
    catch { return false; }
  }

  /** Run a shell command; resolves { code, stdout, stderr, timedOut }. */
  run(cmd, { timeoutMs = config.budgets.shellTimeoutMs, network = false } = {}) {
    const argv = this.mode === "docker"
      ? ["docker", "run", "--rm",
         "--network", network ? "bridge" : "none",
         "--memory", "2g", "--cpus", "2",
         "-v", `${this.dir}:/workspace`, "-w", "/workspace",
         config.sandbox.dockerImage, "bash", "-lc", cmd]
      : ["bash", "-lc", cmd];

    return new Promise((res) => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: this.mode === "host" ? this.dir : undefined,
        env: { ...process.env, CI: "1" },
      });
      let stdout = "", stderr = "", timedOut = false;
      const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        clearTimeout(t);
        res({ code: timedOut ? 124 : code ?? 1, stdout: cap(stdout), stderr: cap(stderr), timedOut });
      });
    });
  }
}

const cap = (s, n = 12_000) => (s.length > n ? s.slice(0, n / 2) + `\n…[${s.length - n} bytes truncated]…\n` + s.slice(-n / 2) : s);
