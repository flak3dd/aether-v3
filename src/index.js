#!/usr/bin/env node
import { createInterface } from "node:readline";
import { assertConfig } from "./config.js";
import { attachCliLogger } from "./events.js";
import { Foreman } from "./foreman.js";

assertConfig();
attachCliLogger();

const goal = process.argv.slice(2).join(" ").trim() || (await prompt("Build goal: "));
if (!goal) { console.error("No goal given. Usage: npm start -- \"Build a Node.js API with JWT auth and Jest tests\""); process.exit(1); }

console.log(`\n⚡ Aether v3 — Foreman Mode\nGoal: ${goal}\n`);
const ok = await new Foreman(goal).run().catch((e) => { console.error("Fatal:", e); return false; });
process.exit(ok ? 0 : 1);

function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a.trim()); }));
}
