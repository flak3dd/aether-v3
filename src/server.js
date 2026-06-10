import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { Foreman } from "./foreman.js";
import { bus } from "./events.js";
import { assertConfig, config } from "./config.js";

// Verify environment variables are set correctly
assertConfig();

// Enable API mode to prevent promptCli from blocking on stdin
process.env.AETHER_API_MODE = "true";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");

const PORT = process.env.AETHER_PORT || 8080;

let activeForeman = null;
let activeEvents = [];

// Helper to write config variables back to .env file on disk
function updateEnvFile(updates) {
  const envPath = resolve(PROJECT_ROOT, ".env");
  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf8");
  }
  const lines = content.split("\n");
  const keys = Object.keys(updates);
  const updatedKeys = new Set();
  
  const newLines = lines.map(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1];
      if (keys.includes(key)) {
        updatedKeys.add(key);
        return `${key}=${updates[key]}`;
      }
    }
    return line;
  });

  // Append missing keys
  for (const key of keys) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${updates[key]}`);
    }
  }

  writeFileSync(envPath, newLines.join("\n"));
}

// Broadcast a message to all connected clients
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

// Get the current active build state
function getActiveState() {
  if (!activeForeman) return null;
  try {
    return {
      turn: activeForeman.turn,
      dod: activeForeman.dod.read(),
      ledger: activeForeman.ledger.read()
    };
  } catch (e) {
    return null;
  }
}

// Attach event handlers to the global bus
const eventsToTrack = [
  "turn:start", "tool:call", "tool:result", "dod:check", "dod:burndown",
  "escalation:rung", "worker:spawn", "worker:done", "critic:check-added",
  "human:question", "human:answer", "build:complete", "build:failed",
  "worker:tool:call", "worker:tool:result", "critic:tool:call", "critic:tool:result"
];

for (const eventName of eventsToTrack) {
  bus.on(eventName, (data) => {
    const eventObj = {
      type: eventName,
      data,
      timestamp: Date.now(),
      state: getActiveState()
    };
    activeEvents.push(eventObj);
    if (activeEvents.length > 1000) activeEvents.shift();
    broadcast(eventObj);
  });
}

// HTTP Server
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS headers for convenience
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // --- API Endpoints ---

  // GET /api/config - Retrieve current configuration
  if (pathname === "/api/config" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      apiProvider: config.apiProvider,
      apiKey: config.apiKey ? "••••••••••••••••" : "",
      geminiApiKey: config.geminiApiKey ? "••••••••••••••••" : "",
      vertexProjectId: config.vertex.projectId || "",
      vertexRegion: config.vertex.region || "",
      foremanModel: config.models.foreman || "",
      workerModel: config.models.worker || "",
      criticModel: config.models.critic || ""
    }));
    return;
  }

  // POST /api/config - Save configuration settings
  if (pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const {
          apiProvider,
          apiKey,
          geminiApiKey,
          vertexProjectId,
          vertexRegion,
          foremanModel,
          workerModel,
          criticModel
        } = payload;

        config.apiProvider = apiProvider;
        if (apiKey && apiKey !== "••••••••••••••••") {
          config.apiKey = apiKey;
        }
        if (geminiApiKey && geminiApiKey !== "••••••••••••••••") {
          config.geminiApiKey = geminiApiKey;
        }
        config.vertex.projectId = vertexProjectId;
        config.vertex.region = vertexRegion;
        config.models.foreman = foremanModel;
        config.models.worker = workerModel;
        config.models.critic = criticModel;

        const envUpdates = {
          AETHER_API_PROVIDER: apiProvider,
          ANTHROPIC_VERTEX_PROJECT_ID: vertexProjectId,
          CLOUD_ML_REGION: vertexRegion,
          AETHER_FOREMAN_MODEL: foremanModel,
          AETHER_WORKER_MODEL: workerModel,
          AETHER_CRITIC_MODEL: criticModel
        };
        if (apiKey && apiKey !== "••••••••••••••••") {
          envUpdates.ANTHROPIC_API_KEY = apiKey;
        }
        if (geminiApiKey && geminiApiKey !== "••••••••••••••••") {
          envUpdates.GEMINI_API_KEY = geminiApiKey;
        }
        updateEnvFile(envUpdates);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  
  // GET /api/builds - List past builds
  if (pathname === "/api/builds" && req.method === "GET") {
    try {
      const buildsDir = resolve(PROJECT_ROOT, config.paths.buildsRoot);
      if (!existsSync(buildsDir)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      const builds = [];
      const folders = readdirSync(buildsDir).filter(f => f.startsWith("build-"));
      
      for (const folder of folders) {
        const dir = join(buildsDir, folder);
        const dodPath = join(dir, ".aether", "dod.json");
        const ledgerPath = join(dir, ".aether", "ledger.json");
        
        let goal = "Unknown Goal";
        let status = null;
        let turnCount = 0;
        let mtime = statSync(dir).mtimeMs;

        if (existsSync(dodPath)) {
          try {
            const dod = JSON.parse(readFileSync(dodPath, "utf8"));
            if (dod.burndown && dod.burndown.length) {
              const lastBd = dod.burndown[dod.burndown.length - 1];
              status = {
                passing: lastBd.passing,
                total: lastBd.total,
                allGreen: lastBd.passing === lastBd.total && lastBd.total > 0
              };
              turnCount = lastBd.turn;
            }
          } catch {}
        }
        if (existsSync(ledgerPath)) {
          try {
            const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
            // Goal isn't stored in ledger, but we can search for it in dod.json, or reconstruct
          } catch {}
        }

        // Try reading goal from git commit messages if possible, or read dod
        try {
          const gitLog = execSync("git log --reverse --oneline", { cwd: dir, encoding: "utf8" });
          const firstLine = gitLog.split("\n")[0];
          // We can read first turn description or DoD commit
        } catch {}

        builds.push({
          id: folder,
          status,
          turnCount,
          timestamp: mtime
        });
      }

      // Sort by newest first
      builds.sort((a, b) => b.timestamp - a.timestamp);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(builds));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/builds/:id - Detailed build info
  if (pathname.startsWith("/api/builds/") && req.method === "GET") {
    const id = pathname.substring("/api/builds/".length);
    try {
      const dir = resolve(PROJECT_ROOT, config.paths.buildsRoot, id);
      if (!existsSync(dir)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Build not found" }));
        return;
      }

      const dodPath = join(dir, ".aether", "dod.json");
      const ledgerPath = join(dir, ".aether", "ledger.json");
      
      const dod = existsSync(dodPath) ? JSON.parse(readFileSync(dodPath, "utf8")) : null;
      const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;
      
      let gitLog = "";
      try {
        gitLog = execSync("git log --oneline -n 30", { cwd: dir, encoding: "utf8" });
      } catch {}

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, dod, ledger, gitLog }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/skills - List distilled skills
  if (pathname === "/api/skills" && req.method === "GET") {
    try {
      const skillsDir = resolve(PROJECT_ROOT, config.paths.skillsLibrary);
      if (!existsSync(skillsDir)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      const skills = readdirSync(skillsDir)
        .filter(f => f.endsWith(".md"))
        .map(f => {
          const content = readFileSync(join(skillsDir, f), "utf8");
          const tagsMatch = content.match(/^tags:\s*(.+)$/m);
          const tags = tagsMatch ? tagsMatch[1].split(/[\s,]+/) : [];
          return {
            file: f,
            tags,
            content
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(skills));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/builds - Start a new build
  if (pathname === "/api/builds" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.goal) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Goal is required" }));
          return;
        }

        if (activeForeman) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A build is already in progress" }));
          return;
        }

        activeEvents = [];
        activeForeman = new Foreman(payload.goal);

        // Run in the background
        activeForeman.run()
          .then((success) => {
            const state = getActiveState();
            const endEvent = {
              type: "build:end",
              data: { success },
              timestamp: Date.now(),
              state
            };
            activeEvents.push(endEvent);
            broadcast(endEvent);
            activeForeman = null;
          })
          .catch((err) => {
            console.error("[Server Error] Foreman run crashed:", err);
            const endEvent = {
              type: "build:end",
              data: { success: false, error: err.message },
              timestamp: Date.now(),
              state: null
            };
            activeEvents.push(endEvent);
            broadcast(endEvent);
            activeForeman = null;
          });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "started", workspace: activeForeman.workspaceDir }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/questions/:id/answer - Submit human answer
  if (pathname.startsWith("/api/questions/") && pathname.endsWith("/answer") && req.method === "POST") {
    const parts = pathname.split("/");
    const id = parts[3]; // /api/questions/:id/answer -> parts = ["", "api", "questions", "q-1", "answer"]
    
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.answer) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Answer is required" }));
          return;
        }

        if (!activeForeman) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No active build to answer for" }));
          return;
        }

        const success = activeForeman.humanQueue.submitAnswer(id, payload.answer);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Serve Static Assets from public/ ---
  if (req.method === "GET") {
    let file = pathname === "/" ? "index.html" : pathname.substring(1);
    const absPath = join(PUBLIC_DIR, file);

    // Security path jail check
    const rel = relative(PUBLIC_DIR, absPath);
    if (rel.startsWith("..")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(absPath) || statSync(absPath).isDirectory()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const mimes = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml"
    };

    const ext = extname(absPath);
    res.writeHead(200, { "Content-Type": mimes[ext] || "text/plain" });
    res.end(readFileSync(absPath));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Send current state on connection
  const active = !!activeForeman;
  const statePayload = {
    type: "init",
    data: {
      active,
      goal: activeForeman?.goal || null,
      workspace: activeForeman?.workspaceDir || null,
      events: activeEvents,
      state: getActiveState()
    }
  };
  ws.send(JSON.stringify(statePayload));
});

// Start listening
server.listen(PORT, () => {
  console.log(`\n⚡ Aether Server listening at http://localhost:${PORT}\n`);
});
