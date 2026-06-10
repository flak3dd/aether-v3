import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";

/** Path jail: every file tool resolves inside the workspace or throws. */
export function jail(workspaceDir, p) {
  const abs = resolve(workspaceDir, p);
  const rel = relative(resolve(workspaceDir), abs);
  if (rel.startsWith("..")) throw new Error(`Path escapes workspace: ${p}`);
  return abs;
}

/**
 * File leases make parallel workers safe: a worker may only write paths it
 * holds a lease on; overlapping leases are refused at spawn time. The
 * foreman (owner === "foreman") bypasses leasing — integration is its job.
 */
export class LeaseRegistry {
  constructor() { this.leases = new Map(); } // path -> workerId
  acquire(workerId, paths) {
    for (const p of paths) {
      const holder = this.leases.get(p);
      if (holder && holder !== workerId) throw new Error(`Lease conflict on ${p}: held by ${holder}`);
    }
    paths.forEach((p) => this.leases.set(p, workerId));
  }
  release(workerId) {
    for (const [p, id] of this.leases) if (id === workerId) this.leases.delete(p);
  }
  assertWritable(owner, path) {
    if (owner === "foreman") return;
    if (this.leases.get(path) !== owner) throw new Error(`${owner} has no lease on ${path}`);
  }
}

/** Anthropic tool schemas shared by foreman and (a subset by) workers. */
export const TOOL_SCHEMAS = [
  { name: "read_file", description: "Read a workspace file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Write complete file contents (no placeholders, no elisions).", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "list_files", description: "Recursive workspace listing.", input_schema: { type: "object", properties: {} } },
  { name: "search_codebase", description: "Regex search across workspace files.", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "run_shell", description: "Run a shell command in the sandbox. Set network:true only when fetching dependencies.", input_schema: { type: "object", properties: { cmd: { type: "string" }, network: { type: "boolean" } }, required: ["cmd"] } },
  { name: "ledger_append", description: "Record durable knowledge. Sections: decisions, constraints, failedApproaches, openQuestions.", input_schema: { type: "object", properties: { section: { type: "string" }, entry: { type: "object" } }, required: ["section", "entry"] } },
  { name: "amend_dod", description: "Add or amend a DoD check with justification. Removal is forbidden.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["add", "amend"] }, check: { type: "object" }, id: { type: "string" }, patch: { type: "object" }, justification: { type: "string" } }, required: ["action", "justification"] } },
  { name: "spawn_worker", description: "Delegate a bounded subtask to a fresh-context worker. Provide goal, dodFragment (check ids it must turn green), and leasePaths (exclusive file ownership).", input_schema: { type: "object", properties: { goal: { type: "string" }, dodFragment: { type: "array", items: { type: "string" } }, leasePaths: { type: "array", items: { type: "string" } } }, required: ["goal", "leasePaths"] } },
  { name: "ask_human", description: "Enqueue a question for the human (non-blocking). Continue with non-dependent work.", input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"] } },
  { name: "rollback_to_green", description: "Hard-reset workspace to the last fully-green checkpoint.", input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "claim_complete", description: "Claim the build satisfies the full DoD. Triggers full verification + critic pass.", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
];

/** Subset available to ephemeral workers. */
export const WORKER_TOOL_NAMES = ["read_file", "write_file", "list_files", "search_codebase", "run_shell"];

/** Build the executor map. `ctx` carries workspaceDir, sandbox, ledger, dod, repo, leases, humanQueue, spawnWorker. */
export function makeExecutor(ctx, owner = "foreman") {
  const { workspaceDir, sandbox, ledger, dod, repo, leases, humanQueue } = ctx;

  const handlers = {
    read_file: ({ path }) => readFileSync(jail(workspaceDir, path), "utf8"),

    write_file: ({ path, content }) => {
      leases.assertWritable(owner, path);
      const abs = jail(workspaceDir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return `wrote ${path} (${content.length} bytes)`;
    },

    list_files: () => walk(workspaceDir).join("\n") || "(empty)",

    search_codebase: ({ pattern }) => {
      const re = new RegExp(pattern);
      const hits = [];
      for (const f of walk(workspaceDir)) {
        const abs = join(workspaceDir, f);
        try {
          readFileSync(abs, "utf8").split("\n").forEach((line, i) => {
            if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch { /* binary */ }
      }
      return hits.slice(0, 100).join("\n") || "(no matches)";
    },

    run_shell: async ({ cmd, network }) => {
      const r = await sandbox.run(cmd, { network: !!network });
      return `exit ${r.code}${r.timedOut ? " (TIMEOUT)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    },

    ledger_append: ({ section, entry }) => `recorded ${ledger.append(section, { turn: ctx.turn?.() ?? 0, ...entry })}`,

    amend_dod: ({ action, check, id, patch, justification }) =>
      action === "add"
        ? `added ${dod.addCheck(check, owner, justification)}`
        : (dod.amendCheck(id, patch, justification), `amended ${id}`),

    spawn_worker: (input) => ctx.spawnWorker(input), // wired in foreman.js

    ask_human: ({ question, options }) => `queued ${humanQueue.enqueue(question, options)} — continue with non-blocked work`,

    rollback_to_green: ({ reason }) => {
      if (!repo.hasGreen()) return "REFUSED: no green checkpoint exists yet";
      const sha = repo.rollbackToGreen();
      ledger.append("failedApproaches", { turn: ctx.turn?.() ?? 0, approach: "(pre-rollback state)", whyItFailed: reason });
      return `rolled back to ${sha}`;
    },

    claim_complete: ({ summary }) => ({ __claimComplete: true, summary }),
  };

  return async (name, input) => {
    if (!(name in handlers)) throw new Error(`Unknown tool: ${name}`);
    if (owner !== "foreman" && !WORKER_TOOL_NAMES.includes(name)) throw new Error(`Tool ${name} not available to workers`);
    return handlers[name](input);
  };
}

function walk(root, prefix = "", depth = 0, out = []) {
  if (depth > 4) return out;
  for (const name of readdirSync(join(root, prefix))) {
    if (name === ".git" || name === "node_modules" || name === ".aether") continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, depth + 1, out);
    else out.push(rel);
  }
  return out;
}
