import { modelTurn, toolResultsMessage } from "./llm.js";
import { TOOL_SCHEMAS, makeExecutor } from "./tools/index.js";
import { config } from "./config.js";
import { bus } from "./events.js";

/**
 * The Critic restores the second perspective v1 had and v2 lost — but as
 * executable pressure, not opinion. Different system prompt (ideally a
 * different model via AETHER_CRITIC_MODEL); read/run access; and exactly one
 * write power: ADDING DoD checks. Removal isn't in its tool set, so the
 * additive-only rule is structural, not behavioral.
 */
const CRITIC_SYSTEM = `You are the Aether Critic. The build claims completion. Your job is to BREAK it.
- Probe happy-path assumptions: bad input, missing env, empty states, auth bypass, concurrent use.
- Prefer executable evidence: run commands, write nothing — express every concern as a new DoD check (kind shell/behavior/file_exists) via add_dod_check.
- Add at most 5 checks; make each one sharp and cheap to run. If you genuinely cannot find a credible weakness, add none and say so.
- You cannot remove or weaken existing checks. You cannot edit code.`;

const CRITIC_TOOL_NAMES = ["read_file", "list_files", "search_codebase", "run_shell"];
const ADD_CHECK_SCHEMA = {
  name: "add_dod_check",
  description: "Add a new executable DoD check the build must satisfy.",
  input_schema: {
    type: "object",
    properties: {
      check: { type: "object", description: "{ kind: file_exists|shell|behavior, path?|cmd?, expect? }" },
      justification: { type: "string" },
    },
    required: ["check", "justification"],
  },
};

export async function runCritic(goal, ctx, maxTurns = 10) {
  const execute = makeExecutor(ctx, "foreman"); // read/run via foreman privileges; writes never invoked
  const tools = [...TOOL_SCHEMAS.filter((t) => CRITIC_TOOL_NAMES.includes(t.name)), ADD_CHECK_SCHEMA];
  let added = 0;

  const messages = [{
    role: "user",
    content: `Build goal: ${goal}\n\nCurrent DoD (all green):\n${ctx.dod.toPrompt()}\n\nWorkspace:\n${await execute("list_files", {})}\n\nFind what the foreman missed.`,
  }];

  for (let t = 0; t < maxTurns; t++) {
    const res = await modelTurn({ model: config.models.critic, system: CRITIC_SYSTEM, messages, tools });
    messages.push({ role: "assistant", content: res.raw.content });
    if (!res.toolCalls.length) return { added, verdict: res.text };

    const results = [];
    for (const call of res.toolCalls) {
      bus.emit("critic:tool:call", { id: call.id, name: call.name, input: call.input });
      try {
        let content;
        if (call.name === "add_dod_check") {
          const id = ctx.dod.addCheck(call.input.check, "critic", call.input.justification);
          added++;
          bus.emit("critic:check-added", { id });
          content = `added ${id}`;
        } else {
          content = String(await execute(call.name, call.input));
        }
        results.push({ id: call.id, content });
        bus.emit("critic:tool:result", { id: call.id, name: call.name, ok: true, output: content });
      } catch (e) {
        const content = `ERROR: ${e.message}`;
        results.push({ id: call.id, content, isError: true });
        bus.emit("critic:tool:result", { id: call.id, name: call.name, ok: false, output: content });
      }
    }
    messages.push(toolResultsMessage(results));
  }
  return { added, verdict: "(critic hit turn budget)" };
}
