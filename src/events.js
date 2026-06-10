import { EventEmitter } from "node:events";

/**
 * Global event bus. Everything observable in the system flows through here:
 *   turn:start, turn:end, tool:call, tool:result, dod:check, dod:burndown,
 *   escalation:rung, worker:spawn, worker:done, critic:check-added,
 *   human:question, human:answer, build:complete, build:failed
 *
 * EXTENSION POINT: attach a WebSocket server (or anything else) by importing
 * `bus` and forwarding events. The engine has zero knowledge of any UI.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

// Default CLI sink — human-readable log lines.
const ts = () => new Date().toISOString().slice(11, 19);
export function attachCliLogger() {
  bus.on("turn:start", (n) => console.log(`\n— turn ${n} ${"—".repeat(40)}`));
  bus.on("tool:call", ({ name, brief }) => console.log(`[${ts()}] → ${name} ${brief || ""}`));
  bus.on("tool:result", ({ name, ok }) => console.log(`[${ts()}] ← ${name} ${ok ? "ok" : "FAILED"}`));
  bus.on("dod:burndown", ({ passing, total }) => console.log(`[${ts()}] ◧ DoD ${passing}/${total} green`));
  bus.on("escalation:rung", ({ rung, reason }) => console.log(`[${ts()}] ⚠ escalating → ${rung} (${reason})`));
  bus.on("worker:spawn", ({ id, goal }) => console.log(`[${ts()}] ⚒ worker ${id}: ${goal}`));
  bus.on("critic:check-added", ({ id }) => console.log(`[${ts()}] ⊕ critic added DoD check: ${id}`));
  bus.on("human:question", ({ id, question }) => console.log(`[${ts()}] ? [${id}] ${question}`));
  bus.on("build:complete", () => console.log(`\n✅ Build complete — verified by burndown, not vibecheck.`));
  bus.on("build:failed", ({ reason }) => console.log(`\n❌ Build failed: ${reason}`));
}
