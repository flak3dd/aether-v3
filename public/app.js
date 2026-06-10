// State Management
let socket = null;
let activeGoal = null;
let workspacePath = null;
let burndownHistory = [];
let activeWorkers = new Map(); // workerId -> { goal, leases: [] }

// DOM Cache
const dom = {
  goalInput: document.getElementById("goal-input"),
  launchBtn: document.getElementById("launch-btn"),
  buildsList: document.getElementById("builds-list"),
  skillsList: document.getElementById("skills-list"),
  activeGoalText: document.getElementById("active-goal-text"),
  statusBadge: document.getElementById("status-badge"),
  workspaceBar: document.getElementById("workspace-bar"),
  workspacePath: document.getElementById("workspace-path"),
  metricTurn: document.getElementById("metric-turn"),
  metricBurndown: document.getElementById("metric-burndown"),
  metricRung: document.getElementById("metric-rung"),
  metricRungStrategy: document.getElementById("metric-rung-strategy"),
  metricWorkers: document.getElementById("metric-workers"),
  consoleLog: document.getElementById("console-log"),
  clearConsoleBtn: document.getElementById("clear-console-btn"),
  dodChecklist: document.getElementById("dod-checklist"),
  chartWrapper: document.getElementById("chart-wrapper"),
  burndownSvg: document.getElementById("burndown-svg"),
  ledgerDecisions: document.getElementById("ledger-decisions"),
  ledgerConstraints: document.getElementById("ledger-constraints"),
  ledgerFailures: document.getElementById("ledger-failures"),
  ledgerQuestions: document.getElementById("ledger-questions"),
  gitTimeline: document.getElementById("git-timeline"),
  workerLeases: document.getElementById("worker-leases"),
  humanModal: document.getElementById("human-modal"),
  modalQuestionText: document.getElementById("modal-question-text"),
  modalOptionsContainer: document.getElementById("modal-options-container"),
  modalCustomInputContainer: document.getElementById("modal-custom-input-container"),
  modalTextInput: document.getElementById("modal-text-input"),
  modalSubmitTextBtn: document.getElementById("modal-submit-text-btn"),
  buildModal: document.getElementById("build-modal"),
  buildModalTitle: document.getElementById("build-modal-title"),
  buildModalDod: document.getElementById("build-modal-dod"),
  buildModalGit: document.getElementById("build-modal-git"),
  buildModalDecisions: document.getElementById("build-modal-decisions"),
  buildModalFailures: document.getElementById("build-modal-failures"),
  closeModalBtns: document.querySelectorAll(".close-modal-btn"),
  configBtn: document.getElementById("config-btn"),
  configModal: document.getElementById("config-modal"),
  configForm: document.getElementById("config-form"),
  configProvider: document.getElementById("config-provider"),
  configApiKey: document.getElementById("config-api-key"),
  configGeminiApiKey: document.getElementById("config-gemini-api-key"),
  configVertexProject: document.getElementById("config-vertex-project"),
  configVertexRegion: document.getElementById("config-vertex-region"),
  configModelForeman: document.getElementById("config-model-foreman"),
  configModelWorker: document.getElementById("config-model-worker"),
  configModelCritic: document.getElementById("config-model-critic"),
  closeConfigBtn: document.getElementById("close-config-btn")
};

// Initialize WebSocket & Fetch past records
function init() {
  setupTabs();
  connectWebSocket();
  fetchPastBuilds();
  fetchSkills();

  dom.launchBtn.addEventListener("click", launchBuild);
  dom.clearConsoleBtn.addEventListener("click", () => {
    dom.consoleLog.innerHTML = `<div class="log-entry system-msg">Log cleared. Stream active...</div>`;
  });

  dom.closeModalBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      dom.buildModal.classList.remove("active");
    });
  });

  dom.configBtn.addEventListener("click", openConfigModal);
  dom.closeConfigBtn.addEventListener("click", () => dom.configModal.classList.remove("active"));
  dom.configProvider.addEventListener("change", toggleConfigProviderFields);
  dom.configForm.addEventListener("submit", saveConfig);

  // Close modal when clicking background
  window.addEventListener("click", (e) => {
    if (e.target === dom.buildModal) dom.buildModal.classList.remove("active");
    if (e.target === dom.configModal) dom.configModal.classList.remove("active");
  });
}

// Tab Switching Mechanism
function setupTabs() {
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      
      tabButtons.forEach(b => b.classList.remove("active"));
      tabPanels.forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(`panel-${target}`).classList.add("active");

      // Redraw SVG chart if moving to DoD tab to avoid width/height calculation errors
      if (target === "dod") {
        setTimeout(renderChart, 50);
      }
    });
  });
}

// WebSocket Connection Setup
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(socketUrl);

  socket.onopen = () => {
    console.log("WebSocket connected to engine");
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      handleEngineEvent(payload);
    } catch (e) {
      console.error("Error parsing WebSocket event:", e);
    }
  };

  socket.onclose = () => {
    console.warn("WebSocket closed. Attempting reconnect in 3s...");
    setTimeout(connectWebSocket, 3000);
  };
}

// Dispatch Engine Events to dashboard updates
function handleEngineEvent(event) {
  const { type, data, timestamp, state } = event;

  // Append entry to live console log
  appendConsoleLog(event);

  // Update dynamic state from turn summaries (if present in message envelope)
  if (state) {
    updateStateFromEngine(state);
  }

  switch (type) {
    case "init":
      handleInit(data);
      break;

    case "build:start":
      handleBuildStart(data);
      break;

    case "turn:start":
      dom.metricTurn.textContent = data;
      break;

    case "dod:burndown":
      dom.metricBurndown.textContent = `${data.passing} / ${data.total}`;
      // Log history point
      const turn = state ? state.turn : (burndownHistory.length + 1);
      burndownHistory.push({ turn, passing: data.passing, total: data.total });
      renderChart();
      break;

    case "escalation:rung":
      dom.metricRung.textContent = data.rung.toUpperCase();
      dom.metricRung.style.color = getRungColor(data.rung);
      dom.metricRungStrategy.textContent = getRungStrategy(data.rung);
      break;

    case "worker:spawn":
      activeWorkers.set(data.id, { goal: data.goal, leases: [] });
      renderActiveWorkers();
      break;

    case "worker:done":
      activeWorkers.delete(data.id);
      renderActiveWorkers();
      break;

    case "human:question":
      showHumanModal(data);
      break;

    case "human:answer":
      hideHumanModal();
      break;

    case "build:complete":
      dom.statusBadge.textContent = "Complete";
      dom.statusBadge.className = "badge success";
      activeGoal = null;
      dom.launchBtn.disabled = false;
      dom.launchBtn.textContent = "Launch Foreman";
      fetchPastBuilds();
      fetchSkills();
      break;

    case "build:failed":
      dom.statusBadge.textContent = "Failed";
      dom.statusBadge.className = "badge failure";
      activeGoal = null;
      dom.launchBtn.disabled = false;
      dom.launchBtn.textContent = "Launch Foreman";
      fetchPastBuilds();
      break;

    case "build:end":
      if (data.success) {
        dom.statusBadge.textContent = "Complete";
        dom.statusBadge.className = "badge success";
        fetchSkills();
      } else {
        dom.statusBadge.textContent = "Failed";
        dom.statusBadge.className = "badge failure";
      }
      activeGoal = null;
      dom.launchBtn.disabled = false;
      dom.launchBtn.textContent = "Launch Foreman";
      fetchPastBuilds();
      break;
  }
}

// Initial client connection sync
function handleInit(data) {
  activeGoal = data.goal;
  workspacePath = data.workspace;
  activeWorkers.clear();

  if (activeGoal) {
    dom.activeGoalText.textContent = activeGoal;
    dom.statusBadge.textContent = "Running";
    dom.statusBadge.className = "badge running";
    dom.launchBtn.disabled = true;
    dom.launchBtn.textContent = "Foreman Active";
    dom.workspaceBar.style.display = "flex";
    dom.workspacePath.textContent = workspacePath;
  } else {
    dom.activeGoalText.textContent = "No active build running. Enter a goal in the sidebar to start.";
    dom.statusBadge.textContent = "Idle";
    dom.statusBadge.className = "badge idle";
    dom.launchBtn.disabled = false;
    dom.launchBtn.textContent = "Launch Foreman";
    dom.workspaceBar.style.display = "none";
  }

  // Load previous events history
  dom.consoleLog.innerHTML = "";
  if (data.events && data.events.length) {
    data.events.forEach(ev => appendConsoleLog(ev));
  } else {
    dom.consoleLog.innerHTML = `<div class="log-entry system-msg">Studio workspace ready. Launch build to trace logs.</div>`;
  }

  // Re-sync UI state if running
  if (data.state) {
    updateStateFromEngine(data.state);
    
    // Reconstruct burndownHistory from events
    burndownHistory = [];
    data.events.forEach(ev => {
      if (ev.type === "dod:burndown") {
        burndownHistory.push({
          turn: ev.state ? ev.state.turn : (burndownHistory.length + 1),
          passing: ev.data.passing,
          total: ev.data.total
        });
      }
    });
    renderChart();
  }
}

function handleBuildStart(data) {
  activeGoal = data.goal;
  dom.activeGoalText.textContent = activeGoal;
  dom.statusBadge.textContent = "Running";
  dom.statusBadge.className = "badge running";
  dom.launchBtn.disabled = true;
  dom.launchBtn.textContent = "Foreman Active";
  dom.consoleLog.innerHTML = `<div class="log-entry system-msg">Foreman launched. Structuring build goal: "${data.goal}"...</div>`;
  dom.metricTurn.textContent = "1";
  dom.metricBurndown.textContent = "-";
  dom.metricRung.textContent = "RETRY";
  dom.metricRung.style.color = getRungColor("retry");
  dom.metricRungStrategy.textContent = getRungStrategy("retry");
  burndownHistory = [];
  activeWorkers.clear();
  renderActiveWorkers();
  renderChart();
}

// Populate structural widgets (DoD + Ledger) using the latest state object
function updateStateFromEngine(state) {
  // Update Turn Count
  dom.metricTurn.textContent = state.turn;

  // Render DoD checks
  renderDoD(state.dod);

  // Render Project Ledger
  renderLedger(state.ledger);

  // Render Git Timeline if repo details change (reconstruct from ledger or state)
  // Note: Git commits show up in the ledger or logs, we can list them from active events as well.
  renderGitTimeline();
}

// Render the Definition of Done checklist
function renderDoD(dod) {
  if (!dod || !dod.checks || !dod.checks.length) {
    dom.dodChecklist.innerHTML = `<li class="list-empty">No checks committed yet.</li>`;
    dom.metricBurndown.textContent = "-";
    return;
  }

  const passing = dod.checks.filter(c => c.status === "pass").length;
  dom.metricBurndown.textContent = `${passing} / ${dod.checks.length}`;

  dom.dodChecklist.innerHTML = dod.checks.map(c => `
    <li class="dod-item ${c.status}">
      <div class="dod-status-indicator">
        ${c.status === "pass" ? "✔" : c.status === "fail" ? "✘" : "●"}
      </div>
      <div class="dod-check-body">
        <span class="dod-check-id">${c.id}</span>
        <div class="dod-check-cmd">${escapeHtml(c.cmd || c.path)}</div>
        <div class="dod-check-details">
          ${c.kind.toUpperCase()} ${c.expect ? ` ➔ Expects "${escapeHtml(c.expect)}"` : ""}
        </div>
        <div class="dod-check-by">Added by ${c.addedBy}</div>
      </div>
    </li>
  `).join("");
}

// Render the Project Ledger (Decisions, Constraints, Failed Approaches, Open Questions)
function renderLedger(ledger) {
  if (!ledger) return;

  const renderList = (el, items, formatter) => {
    if (!items || !items.length) {
      el.innerHTML = `<li class="list-empty">No records.</li>`;
    } else {
      el.innerHTML = items.map(formatter).join("");
    }
  };

  renderList(dom.ledgerDecisions, ledger.decisions, d => `
    <li class="ledger-item">
      <div class="ledger-item-header">[${d.id} | Turn ${d.turn} | Source: ${d.source}]</div>
      <div><strong>${escapeHtml(d.decision)}</strong></div>
      <div style="font-size: 11px; color: var(--color-text-muted); margin-top: 4px;">Rationale: ${escapeHtml(d.rationale)}</div>
    </li>
  `);

  renderList(dom.ledgerConstraints, ledger.constraints, c => `
    <li class="ledger-item">
      <div class="ledger-item-header">[${c.id} | Turn ${c.turn}]</div>
      <div>${escapeHtml(c.constraint)}</div>
    </li>
  `);

  renderList(dom.ledgerFailures, ledger.failedApproaches, f => `
    <li class="ledger-item">
      <div class="ledger-item-header">[${f.id} | Turn ${f.turn}]</div>
      <div><strong>Approach:</strong> ${escapeHtml(f.approach)}</div>
      <div style="color: var(--status-failure); margin-top: 4px;"><strong>Failure:</strong> ${escapeHtml(f.whyItFailed)}</div>
    </li>
  `);

  renderList(dom.ledgerQuestions, ledger.openQuestions, q => `
    <li class="ledger-item">
      <div class="ledger-item-header">[${q.id} | Turn ${q.turn}]</div>
      <div>${escapeHtml(q.question)}</div>
    </li>
  `);
}

// Extract git commits from event log to show timeline
function renderGitTimeline() {
  const commitEvents = Array.from(dom.consoleLog.children)
    .filter(child => child.dataset.type === "tool-result" && child.dataset.name === "commitTurn")
    .map(child => {
      try {
        const text = child.querySelector(".log-message").textContent;
        const out = child.querySelector(".log-details").textContent;
        // Parse sha out
        const sha = out.split(" ")[1] || "HEAD";
        const msg = text.split("commitTurn")[1] || "Commit checkpoint";
        return { sha, msg, timestamp: Number(child.dataset.time) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!commitEvents.length) {
    dom.gitTimeline.innerHTML = `<p class="list-empty">No commits made yet.</p>`;
    return;
  }

  dom.gitTimeline.innerHTML = commitEvents.map(c => `
    <div class="timeline-node">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-header">
          <span class="timeline-sha">${c.sha}</span>
          <span>${new Date(c.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="timeline-msg">${escapeHtml(c.msg.trim())}</div>
      </div>
    </div>
  `).join("");
}

// Render active worker subagents and lease locks
function renderActiveWorkers() {
  if (!activeWorkers.size) {
    dom.workerLeases.innerHTML = `<p class="list-empty">No active worker subagents.</p>`;
    dom.metricWorkers.textContent = "0";
    return;
  }

  dom.metricWorkers.textContent = activeWorkers.size;

  let html = "";
  activeWorkers.forEach((val, key) => {
    // Collect lease paths assigned to this worker in the leases maps
    const leasesList = val.leases.map(l => `<span class="lease-pill">🔒 ${escapeHtml(l)}</span>`).join("");
    html += `
      <div class="worker-card">
        <div class="worker-header">
          <span class="worker-id">${key}</span>
          <span class="badge running" style="font-size:9px; padding: 2px 8px;">Active</span>
        </div>
        <div class="worker-goal">${escapeHtml(val.goal)}</div>
        <div class="worker-leases">
          ${leasesList || '<span style="font-size:11px; color:#555;">No leases held</span>'}
        </div>
      </div>
    `;
  });

  dom.workerLeases.innerHTML = html;
}

// Append log entry elements dynamically to console box
function appendConsoleLog(eventObj) {
  const { type, data, timestamp } = eventObj;
  const entry = document.createElement("div");
  entry.className = "log-entry";
  entry.dataset.time = timestamp;

  const timeStr = new Date(timestamp).toLocaleTimeString();
  let logText = "";
  let detailsText = "";

  if (type === "init") {
    entry.className += " system-msg";
    logText = `[SYSTEM] Synchronized studio with session.`;
  } else if (type === "turn:start") {
    entry.className += " turn-start";
    logText = `[TURN] Started Turn ${data}`;
  } else if (type === "tool:call") {
    entry.className += " tool-call";
    logText = `[FOREMAN] Calling tool ${data.name} ${data.brief ? `(${data.brief})` : ""}`;
    if (data.input) detailsText = JSON.stringify(data.input, null, 2);
    entry.dataset.name = data.name;
    entry.dataset.type = "tool-call";
  } else if (type === "tool:result") {
    entry.className += " tool-result";
    logText = `[FOREMAN] Tool ${data.name} completed [${data.ok ? "SUCCESS" : "FAILED"}]`;
    if (data.output) detailsText = data.output;
    entry.dataset.name = data.name;
    entry.dataset.type = "tool-result";
  } else if (type === "worker:tool:call") {
    entry.className += " worker-event";
    logText = `[WORKER ${data.workerId}] Calling tool ${data.name}`;
    if (data.input) detailsText = JSON.stringify(data.input, null, 2);
  } else if (type === "worker:tool:result") {
    entry.className += " worker-event";
    logText = `[WORKER ${data.workerId}] Tool ${data.name} completed [${data.ok ? "SUCCESS" : "FAILED"}]`;
    if (data.output) detailsText = data.output;
  } else if (type === "critic:tool:call") {
    entry.className += " critic-event";
    logText = `[CRITIC] Calling tool ${data.name}`;
    if (data.input) detailsText = JSON.stringify(data.input, null, 2);
  } else if (type === "critic:tool:result") {
    entry.className += " critic-event";
    logText = `[CRITIC] Tool ${data.name} completed [${data.ok ? "SUCCESS" : "FAILED"}]`;
    if (data.output) detailsText = data.output;
  } else if (type === "dod:check") {
    entry.className += " check-update";
    logText = `[VERIFY] Check ${data.id} is ${data.status.toUpperCase()}`;
  } else if (type === "dod:burndown") {
    entry.className += " check-update";
    logText = `[BURNDOWN] Burn-down progression: ${data.passing} / ${data.total} green`;
  } else if (type === "escalation:rung") {
    entry.className += " escalation";
    logText = `[ESCALATION] Escalating rung to ${data.rung.toUpperCase()}. Reason: ${data.reason}`;
  } else if (type === "worker:spawn") {
    entry.className += " worker-event";
    logText = `[WORKER] Spawned subagent ${data.id} with goal: "${data.goal}"`;
    // Update leases registry cache
    if (activeWorkers.has(data.id)) {
      activeWorkers.get(data.id).leases = data.leasePaths || [];
      renderActiveWorkers();
    }
  } else if (type === "worker:done") {
    entry.className += " worker-event";
    logText = `[WORKER] Subagent ${data.id} finished [${data.ok ? "SUCCESS" : "FAILED"}]`;
  } else if (type === "critic:check-added") {
    entry.className += " critic-event";
    logText = `[CRITIC] Checklist expanded. Added adversarial check: ${data.id}`;
  } else if (type === "human:question") {
    entry.className += " question";
    logText = `[HUMAN ESCALATION] Question ${data.id}: "${data.question}"`;
  } else if (type === "human:answer") {
    entry.className += " question";
    logText = `[HUMAN ANSWER] Answered question ${data.id} with: "${data.answer}"`;
  } else if (type === "build:complete") {
    entry.className += " success-msg";
    logText = `[COMPLETE] Build completed successfully. Verified by burndown, not vibecheck.`;
  } else if (type === "build:failed") {
    entry.className += " failure-msg";
    logText = `[FAILED] Build aborted: ${data.reason}`;
  } else if (type === "build:end") {
    if (data.success) {
      entry.className += " success-msg";
      logText = `[COMPLETE] Build completed.`;
    } else {
      entry.className += " failure-msg";
      logText = `[ERROR] Build halted: ${data.error || "Unknown exception"}`;
    }
  } else {
    entry.className += " system-msg";
    logText = `[EVENT] ${type}`;
  }

  entry.innerHTML = `
    <span style="color:#4a5568;">[${timeStr}]</span> 
    <span class="log-message">${escapeHtml(logText)}</span>
    ${detailsText ? `<div class="log-details">${escapeHtml(detailsText)}</div>` : ""}
  `;

  // Attach expand click listener if there are details
  if (detailsText) {
    entry.style.cursor = "pointer";
    entry.addEventListener("click", () => {
      entry.classList.toggle("expanded");
    });
  }

  // Keep scroll focused
  const shouldScroll = dom.consoleLog.scrollHeight - dom.consoleLog.clientHeight <= dom.consoleLog.scrollTop + 60;
  dom.consoleLog.appendChild(entry);
  if (shouldScroll) {
    dom.consoleLog.scrollTop = dom.consoleLog.scrollHeight;
  }
}

// Render dynamic SVG Line Chart plotting passing checks vs. Turn number
function renderChart() {
  const svg = dom.burndownSvg;
  const container = dom.chartWrapper;
  if (!svg || !container || !burndownHistory.length) return;

  const width = container.clientWidth - 32;
  const height = 200;
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const paddingLeft = 40;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 30;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const maxTurns = Math.max(...burndownHistory.map(h => h.turn), 10);
  const maxChecks = Math.max(...burndownHistory.map(h => h.total), 5);

  // Draw background grid lines
  const gridGroup = svg.querySelector(".grid-lines");
  gridGroup.innerHTML = "";

  // Horizontal check lines
  for (let i = 0; i <= maxChecks; i++) {
    const y = paddingTop + chartHeight - (i / maxChecks) * chartHeight;
    // Line
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", paddingLeft);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - paddingRight);
    line.setAttribute("y2", y);
    line.setAttribute("class", "grid-line");
    gridGroup.appendChild(line);
    
    // Label
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", paddingLeft - 8);
    text.setAttribute("y", y + 4);
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "grid-text");
    text.textContent = i;
    gridGroup.appendChild(text);
  }

  // Generate points coordinates
  const points = burndownHistory.map(h => {
    const x = paddingLeft + (h.turn / maxTurns) * chartWidth;
    const y = paddingTop + chartHeight - (h.passing / h.total) * chartHeight;
    return { x, y, turn: h.turn, passing: h.passing, total: h.total };
  });

  // Draw Line path
  const linePath = svg.querySelector(".chart-line");
  const areaPath = svg.querySelector(".chart-area");
  
  if (points.length > 0) {
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      d += ` L ${points[i].x} ${points[i].y}`;
    }
    linePath.setAttribute("d", d);

    // Area path closing coordinates
    let dArea = d + ` L ${points[points.length - 1].x} ${paddingTop + chartHeight} L ${points[0].x} ${paddingTop + chartHeight} Z`;
    areaPath.setAttribute("d", dArea);
  }

  // Draw points
  const pointsGroup = svg.querySelector(".chart-points");
  pointsGroup.innerHTML = "";
  points.forEach(pt => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", 4);
    circle.setAttribute("class", "chart-point");
    
    // Simple tooltip title
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `Turn ${pt.turn}: ${pt.passing} / ${pt.total} green`;
    circle.appendChild(title);
    
    pointsGroup.appendChild(circle);
  });

  // Draw Turn labels along X axis
  const turnInterval = Math.max(1, Math.floor(maxTurns / 5));
  for (let i = 0; i <= maxTurns; i += turnInterval) {
    const x = paddingLeft + (i / maxTurns) * chartWidth;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", x);
    text.setAttribute("y", height - paddingBottom + 16);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "grid-text");
    text.textContent = `T${i}`;
    gridGroup.appendChild(text);
  }
}

// Fetch historical builds from local directory APIs
async function fetchPastBuilds() {
  try {
    const res = await fetch("/api/builds");
    const builds = await res.json();
    
    if (!builds || !builds.length) {
      dom.buildsList.innerHTML = `<p class="list-empty">No build history found.</p>`;
      return;
    }

    dom.buildsList.innerHTML = builds.map(b => {
      const date = new Date(b.timestamp).toLocaleDateString();
      const statusClass = b.status ? (b.status.allGreen ? "success" : "failure") : "idle";
      const statusText = b.status ? `${b.status.passing}/${b.status.total}` : "Pending";
      return `
        <div class="sidebar-item" onclick="viewBuildDetails('${b.id}')">
          <div class="item-title">${escapeHtml(b.id)}</div>
          <div class="item-meta">
            <span>${date}</span>
            <span class="badge ${statusClass}" style="font-size: 9px; padding: 2px 8px;">${statusText}</span>
          </div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("Error loading builds:", e);
  }
}

// Fetch distilled skills from local database folder
async function fetchSkills() {
  try {
    const res = await fetch("/api/skills");
    const skills = await res.json();

    if (!skills || !skills.length) {
      dom.skillsList.innerHTML = `<p class="list-empty">No skills distilled yet.</p>`;
      return;
    }

    dom.skillsList.innerHTML = skills.map(s => {
      const title = s.content.match(/^#\s+(.+)$/m)?.[1] || s.file;
      const tagsList = s.tags.map(t => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("");
      return `
        <div class="sidebar-item skill-item" onclick="viewSkillMarkdown('${escapeHtml(s.file)}')">
          <div class="item-title">${escapeHtml(title)}</div>
          <div class="worker-leases" style="margin-top: 4px;">${tagsList}</div>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("Error loading skills:", e);
  }
}

// Trigger background build running via HTTP POST
async function launchBuild() {
  const goal = dom.goalInput.value.trim();
  if (!goal) return;

  dom.launchBtn.disabled = true;
  dom.launchBtn.textContent = "Launching...";

  try {
    const res = await fetch("/api/builds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal })
    });
    const result = await res.json();
    if (result.error) {
      alert(`Error starting build: ${result.error}`);
      dom.launchBtn.disabled = false;
      dom.launchBtn.textContent = "Launch Foreman";
    } else {
      dom.goalInput.value = "";
    }
  } catch (e) {
    console.error("Error launching build:", e);
    dom.launchBtn.disabled = false;
    dom.launchBtn.textContent = "Launch Foreman";
  }
}

// Show the human escalation popup overlay
function showHumanModal(data) {
  dom.modalQuestionText.textContent = data.question;
  dom.modalTextInput.value = "";
  dom.modalOptionsContainer.innerHTML = "";

  if (data.options && data.options.length) {
    dom.modalOptionsContainer.innerHTML = data.options.map(opt => `
      <button class="modal-option-btn" onclick="submitHumanAnswer('${data.id}', '${escapeQuote(opt)}')">
        ${escapeHtml(opt)}
      </button>
    `).join("");
    dom.modalCustomInputContainer.style.display = "none";
  } else {
    dom.modalCustomInputContainer.style.display = "flex";
    dom.modalSubmitTextBtn.onclick = () => {
      const val = dom.modalTextInput.value.trim();
      if (val) submitHumanAnswer(data.id, val);
    };
  }

  dom.humanModal.classList.add("active");
}

function hideHumanModal() {
  dom.humanModal.classList.remove("active");
}

// Submit resolved answer back to the endpoint
async function submitHumanAnswer(questionId, answer) {
  try {
    const res = await fetch(`/api/questions/${questionId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer })
    });
    const result = await res.json();
    if (result.success) {
      hideHumanModal();
    } else {
      alert("Failed to register answer");
    }
  } catch (e) {
    console.error("Error submitting answer:", e);
  }
}

// Open and load past build details modal
async function viewBuildDetails(id) {
  try {
    const res = await fetch(`/api/builds/${id}`);
    const details = await res.json();

    dom.buildModalTitle.textContent = `Build Details — ${id}`;
    
    // Render DoD list
    if (details.dod && details.dod.checks) {
      dom.buildModalDod.innerHTML = details.dod.checks.map(c => `
        <li class="dod-item ${c.status}">
          <div class="dod-status-indicator">
            ${c.status === "pass" ? "✔" : c.status === "fail" ? "✘" : "●"}
          </div>
          <div class="dod-check-body">
            <span class="dod-check-id">${c.id}</span>
            <div class="dod-check-cmd">${escapeHtml(c.cmd || c.path)}</div>
            <div class="dod-check-details">Added by ${c.addedBy}</div>
          </div>
        </li>
      `).join("");
    } else {
      dom.buildModalDod.innerHTML = `<li class="list-empty">No DoD information available.</li>`;
    }

    // Git logs
    dom.buildModalGit.textContent = details.gitLog || "No commit logs recorded.";

    // Ledger decisions & failures
    const renderList = (el, items, fmt) => {
      if (!items || !items.length) el.innerHTML = `<li class="list-empty">No records.</li>`;
      else el.innerHTML = items.map(fmt).join("");
    };

    if (details.ledger) {
      renderList(dom.buildModalDecisions, details.ledger.decisions, d => `
        <li class="ledger-item" style="border-left-color: var(--accent-primary);">
          <div><strong>${escapeHtml(d.decision)}</strong></div>
          <div style="font-size: 11px; color: var(--color-text-muted); margin-top: 4px;">Rationale: ${escapeHtml(d.rationale)}</div>
        </li>
      `);
      renderList(dom.buildModalFailures, details.ledger.failedApproaches, f => `
        <li class="ledger-item" style="border-left-color: var(--status-failure);">
          <div><strong>Approach:</strong> ${escapeHtml(f.approach)}</div>
          <div style="color: var(--status-failure); margin-top: 4px;"><strong>Reason:</strong> ${escapeHtml(f.whyItFailed)}</div>
        </li>
      `);
    } else {
      dom.buildModalDecisions.innerHTML = `<li class="list-empty">No ledger decisions.</li>`;
      dom.buildModalFailures.innerHTML = `<li class="list-empty">No ledger failures.</li>`;
    }

    dom.buildModal.classList.add("active");
  } catch (e) {
    alert("Error loading build details: " + e.message);
  }
}

// Open skill markdown in details popup
async function viewSkillMarkdown(file) {
  try {
    const res = await fetch("/api/skills");
    const skills = await res.json();
    const skill = skills.find(s => s.file === file);
    if (!skill) return;

    dom.buildModalTitle.textContent = `Distilled Skill - ${file}`;
    dom.buildModalDod.innerHTML = `<div style="grid-column: span 2; white-space: pre-wrap; font-family: var(--font-mono); font-size:12px; background:#000; padding:15px; border-radius:10px; border: 1px solid var(--color-border); color: #fff;">${escapeHtml(skill.content)}</div>`;
    dom.buildModalGit.textContent = "N/A - Skills Distillation File";
    dom.buildModalDecisions.innerHTML = `<li class="list-empty">N/A</li>`;
    dom.buildModalFailures.innerHTML = `<li class="list-empty">N/A</li>`;
    
    dom.buildModal.classList.add("active");
  } catch (e) {
    alert("Error loading skill markdown");
  }
}

// Configuration Management
async function openConfigModal() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    
    dom.configProvider.value = data.apiProvider || "anthropic";
    dom.configApiKey.value = data.apiKey || "";
    dom.configGeminiApiKey.value = data.geminiApiKey || "";
    dom.configVertexProject.value = data.vertexProjectId || "";
    dom.configVertexRegion.value = data.vertexRegion || "";
    dom.configModelForeman.value = data.foremanModel || "claude-sonnet-4-6";
    dom.configModelWorker.value = data.workerModel || "claude-sonnet-4-6";
    dom.configModelCritic.value = data.criticModel || "claude-sonnet-4-6";

    toggleConfigProviderFields();
    dom.configModal.classList.add("active");
  } catch (e) {
    alert("Error fetching config: " + e.message);
  }
}

function toggleConfigProviderFields() {
  const val = dom.configProvider.value;
  const anthropicSec = document.getElementById("config-anthropic-section");
  const geminiSec = document.getElementById("config-gemini-section");
  const vertexSec = document.getElementById("config-vertex-section");
  
  if (val === "vertex") {
    anthropicSec.style.display = "none";
    geminiSec.style.display = "none";
    vertexSec.style.display = "block";
  } else if (val === "gemini") {
    anthropicSec.style.display = "none";
    geminiSec.style.display = "block";
    vertexSec.style.display = "none";
  } else {
    anthropicSec.style.display = "block";
    geminiSec.style.display = "none";
    vertexSec.style.display = "none";
  }
}

async function saveConfig() {
  const payload = {
    apiProvider: dom.configProvider.value,
    apiKey: dom.configApiKey.value,
    geminiApiKey: dom.configGeminiApiKey.value,
    vertexProjectId: dom.configVertexProject.value,
    vertexRegion: dom.configVertexRegion.value,
    foremanModel: dom.configModelForeman.value,
    workerModel: dom.configModelWorker.value,
    criticModel: dom.configModelCritic.value
  };

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (result.success) {
      alert("Configuration settings saved successfully!");
      dom.configModal.classList.remove("active");
    } else {
      alert("Error saving configuration: " + result.error);
    }
  } catch (e) {
    alert("Error saving config: " + e.message);
  }
}

// Helpers
function getRungColor(rung) {
  return {
    retry: "var(--status-idle)",
    fix: "var(--accent-primary)",
    rollback: "var(--status-failure)",
    replan: "var(--status-warning)",
    human: "var(--accent-secondary)"
  }[rung] || "var(--color-text)";
}

function getRungStrategy(rung) {
  return {
    retry: "Strategy: RETRY. Re-run once to capture exact errors.",
    fix: "Strategy: TARGETED FIX. Make minimal changes to fix errors.",
    rollback: "Strategy: ROLLBACK. Reset to last green state.",
    replan: "Strategy: RE-PLAN. Re-evaluate goal & amend DoD checks.",
    human: "Strategy: ASK HUMAN. Escalate details to human user."
  }[rung] || "None";
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeQuote(str) {
  if (!str) return "";
  return str.replace(/'/g, "\\'");
}

// Start operations
window.onload = init;
