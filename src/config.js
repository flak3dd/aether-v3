import "dotenv/config";

export const config = {
  apiProvider: process.env.AETHER_API_PROVIDER || "anthropic", // "anthropic" | "vertex" | "gemini"
  apiKey: process.env.ANTHROPIC_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  vertex: {
    projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    region: process.env.CLOUD_ML_REGION || "us-central1",
  },
  models: {
    foreman: process.env.AETHER_FOREMAN_MODEL || "claude-sonnet-4-6",
    worker: process.env.AETHER_WORKER_MODEL || "claude-sonnet-4-6",
    critic: process.env.AETHER_CRITIC_MODEL || "claude-sonnet-4-6",
  },
  budgets: {
    maxTurns: Number(process.env.AETHER_MAX_TURNS || 60),
    thrashWindow: Number(process.env.AETHER_THRASH_WINDOW || 6),
    shellTimeoutMs: Number(process.env.AETHER_SHELL_TIMEOUT_MS || 120_000),
    // Per-rung budgets for the escalation ladder (turns allowed on a rung
    // without burn-down movement before auto-escalating).
    ladder: { retry: 2, fix: 4, rollback: 3, replan: 4 },
  },
  sandbox: {
    mode: process.env.AETHER_SANDBOX || "host", // "docker" | "host"
    dockerImage: process.env.AETHER_DOCKER_IMAGE || "node:20-bookworm",
  },
  paths: {
    buildsRoot: "./builds",
    skillsLibrary: "./skills-library",
  },
};

export function assertConfig() {
  if (config.apiProvider === "vertex") {
    if (!config.vertex.projectId) {
      console.error("Missing ANTHROPIC_VERTEX_PROJECT_ID in env when AETHER_API_PROVIDER=vertex.");
      process.exit(1);
    }
    if (!config.vertex.region) {
      console.error("Missing CLOUD_ML_REGION in env when AETHER_API_PROVIDER=vertex.");
      process.exit(1);
    }
  } else if (config.apiProvider === "gemini") {
    if (!config.geminiApiKey) {
      console.error("Missing GEMINI_API_KEY or GOOGLE_API_KEY in env when AETHER_API_PROVIDER=gemini.");
      process.exit(1);
    }
  } else {
    if (!config.apiKey) {
      console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and set it.");
      process.exit(1);
    }
  }
}
