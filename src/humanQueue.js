import { createInterface } from "node:readline";
import { bus } from "./events.js";

/**
 * PRINCIPLE: the human is a parallel resource, not a blocking syscall.
 * ask_human enqueues; the foreman keeps working on non-dependent tasks.
 * Answers land in the ledger as decisions with source:"human".
 *
 * This CLI implementation answers questions between turns via stdin.
 * EXTENSION POINT: swap the prompt loop for a dashboard/WebSocket UI —
 * only enqueue() and drainAnswers() are part of the contract.
 */
export class HumanQueue {
  constructor() {
    this.pending = new Map(); // id -> { question, options }
    this.answers = [];        // { id, answer }
    this.counter = 0;
  }

  enqueue(question, options = []) {
    const id = `q-${++this.counter}`;
    this.pending.set(id, { question, options });
    bus.emit("human:question", { id, question, options });
    return id;
  }

  hasPending() { return this.pending.size > 0; }

  submitAnswer(id, answer) {
    if (this.pending.has(id)) {
      const q = this.pending.get(id);
      this.pending.delete(id);
      this.answers.push({ id, answer });
      bus.emit("human:answer", { id, answer });
      return true;
    }
    return false;
  }

  /**
   * CLI: offer to answer pending questions. Non-blocking in spirit — the
   * foreman calls this between turns; an empty answer defers the question.
   */
  async promptCli() {
    if (process.env.AETHER_API_MODE === "true") return;
    if (!this.pending.size) return;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((r) => rl.question(q, r));
    for (const [id, { question, options }] of [...this.pending]) {
      const opts = options.length ? `\n  options: ${options.join(" | ")}` : "";
      const a = (await ask(`\n? [${id}] ${question}${opts}\n  answer (enter to defer): `)).trim();
      if (a) {
        this.pending.delete(id);
        this.answers.push({ id, answer: a });
        bus.emit("human:answer", { id, answer: a });
      }
    }
    rl.close();
  }

  /** Foreman pulls resolved answers at turn start. */
  drainAnswers() {
    const out = this.answers;
    this.answers = [];
    return out;
  }
}
