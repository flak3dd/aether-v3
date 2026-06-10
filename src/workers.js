import { modelTurn, toolResultsMessage } from "./llm.js";
import { TOOL_SCHEMAS, WORKER_TOOL_NAMES, makeExecutor } from "./tools/index.js";
import { config } from "./config.js";
import { bus } from "./events.js";

/**
 * PRINCIPLE 3: agents are ephemeral.
 * A worker is a fresh-context session bound by a contract:
 *   { goal, dodFragment, leasePaths } — it may only write its leased paths,
 * runs a bounded tool loop, and dies returning a summary. It never sees the
 * foreman's transcript; it sees only what the contract gives it.
 *
 * EXTENSION POINT: this runs workers sequentially when called; because each
 * holds disjoint leases, running several via Promise.all is safe — wire
 * parallel dispatch in foreman.js when ready.
 */
const WORKER_SYSTEM = `You are an Aether worker: an ephemeral builder with a bounded contract.
Rules:
- You may ONLY write files listed in your lease. Reading anything is fine.
- Write complete files; placeholders and "..." elisions are forbidden.
- Verify your own work with run_shell before finishing.
- When done, reply with a plain-text summary: what you built, what you verified, anything the foreman must know (constraints, surprises). Do not exceed your contract's scope.`;

let counter = 0;

export async function runWorker({ goal, dodFragment = [], leasePaths }, ctx, maxTurns = 15) {
  const id = `w-${++counter}`;
  ctx.leases.acquire(id, leasePaths); // throws on conflict — surfaces to foreman as tool error
  bus.emit("worker:spawn", { id, goal });

  const execute = makeExecutor(ctx, id);
  const tools = TOOL_SCHEMAS.filter((t) => WORKER_TOOL_NAMES.includes(t.name));
  const messages = [{
    role: "user",
    content: `CONTRACT
Goal: ${goal}
DoD checks you must turn green: ${dodFragment.join(", ") || "(none specified — satisfy the goal)"}
Your file leases (the ONLY paths you may write): ${leasePaths.join(", ")}

Workspace listing and relevant context:
${await execute("list_files", {})}`,
  }];

  try {
    for (let t = 0; t < maxTurns; t++) {
      const res = await modelTurn({ model: config.models.worker, system: WORKER_SYSTEM, messages, tools });
      messages.push({ role: "assistant", content: res.raw.content });
      if (!res.toolCalls.length) {
        bus.emit("worker:done", { id, ok: true });
        return `[worker ${id}] ${res.text}`;
      }
      const results = [];
      for (const call of res.toolCalls) {
        bus.emit("worker:tool:call", { workerId: id, id: call.id, name: call.name, input: call.input });
        try {
          const out = String(await execute(call.name, call.input));
          results.push({ id: call.id, content: out });
          bus.emit("worker:tool:result", { workerId: id, id: call.id, name: call.name, ok: true, output: out });
        } catch (e) {
          const out = `ERROR: ${e.message}`;
          results.push({ id: call.id, content: out, isError: true });
          bus.emit("worker:tool:result", { workerId: id, id: call.id, name: call.name, ok: false, output: out });
        }
      }
      messages.push(toolResultsMessage(results));
    }
    bus.emit("worker:done", { id, ok: false });
    return `[worker ${id}] HIT TURN BUDGET (${maxTurns}) without finishing — review its leased files.`;
  } finally {
    ctx.leases.release(id);
  }
}
