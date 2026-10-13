/**
 * RoadSense Master Application Controller
 * Orchestrates views, filters, Leaflet map, simulated sensing, and municipal triage workflow.
 */

class RoadSenseApp {
  constructor() {
    this.currentView = "gov"; // 'driver' or 'gov'
    this.issues = [];
    this.selectedIssue = null;
    this.mapController = null;
    this.sensorSimulator = null;
    this.filters = {
      type: "all",
      severity: "all",
      confidence: "all",
      status: "all",
      search: ""
    };
  }

  async init() {
    // Initialize Leaflet Map
    this.mapController = new RoadSenseMap("map", {
      onMarkerSelect: (issue) => this.selectIssue(issue, false)
    });
    await this.mapController.init();

    // Initialize Sensor Simulator on HUD canvas
    this.sensorSimulator = new SensorSimulator("accelerometerWaveCanvas", {
      onAnomalyDetected: (event) => this.handleSimulatedDetection(event)
    });

    // Attach DOM Event Listeners
    this.bindEvents();

    // Load Initial Data
    await this.refreshAll();
  }

  bindEvents() {
    // Navigation Tabs
    document.querySelectorAll(".nav-tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const view = e.currentTarget.dataset.view;
        this.switchView(view);
      });
    });

    // Filters
    const typeFilter = document.getElementById("filterType");
    const sevFilter = document.getElementById("filterSeverity");
    const confFilter = document.getElementById("filterConfidence");
    const statFilter = document.getElementById("filterStatus");
    const searchInput = document.getElementById("searchInput");
    const tileSelect = document.getElementById("tileProviderSelect");

    if (typeFilter) typeFilter.addEventListener("change", (e) => {
      this.filters.type = e.target.value;
      this.applyFilters();
    });

    if (sevFilter) sevFilter.addEventListener("change", (e) => {
      this.filters.severity = e.target.value;
      this.applyFilters();
    });

    if (confFilter) confFilter.addEventListener("change", (e) => {
      this.filters.confidence = e.target.value;
      this.applyFilters();
    });

    if (statFilter) statFilter.addEventListener("change", (e) => {
      this.filters.status = e.target.value;
      this.applyFilters();
    });

    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        this.filters.search = e.target.value;
        this.applyFilters();
      });
    }

    if (tileSelect) {
      tileSelect.addEventListener("change", (e) => {
        this.mapController.setTileProvider(e.target.value);
      });
    }

    // Driver Sensing Buttons
    const toggleSensingBtn = document.getElementById("toggleSensingBtn");
    const triggerBumpBtn = document.getElementById("triggerBumpBtn");

    if (toggleSensingBtn) {
      toggleSensingBtn.addEventListener("click", () => {
        const active = this.sensorSimulator.toggleSimulation();
        toggleSensingBtn.innerText = active ? "Pause Sensing" : "Resume Sensing";
        toggleSensingBtn.className = active ? "btn btn-secondary btn-sm" : "btn btn-primary btn-sm";
      });
    }

    if (triggerBumpBtn) {
      triggerBumpBtn.addEventListener("click", () => {
        this.sensorSimulator.triggerSimulatedAnomaly("pothole");
        this.showToast("⚡ Simulated Pothole Anomaly Detected (Z-axis 3.85G shockwave)!");
      });
    }

    // Manual Report Modal
    const openReportModalBtn = document.getElementById("openReportModalBtn");
    const closeReportModalBtn = document.getElementById("closeReportModalBtn");
    const reportModal = document.getElementById("reportModal");
    const reportForm = document.getElementById("manualReportForm");

    if (openReportModalBtn) {
      openReportModalBtn.addEventListener("click", () => {
        reportModal.classList.add("open");
      });
    }

    if (closeReportModalBtn) {
      closeReportModalBtn.addEventListener("click", () => {
        reportModal.classList.remove("open");
      });
    }

    // Modal Type Pickers
    document.querySelectorAll(".type-select-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        document.querySelectorAll(".type-select-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        document.getElementById("manualReportType").value = card.dataset.type;
      });
    });

    // Modal Severity Pickers
    document.querySelectorAll(".sev-pill").forEach((pill) => {
      pill.addEventListener("click", (e) => {
        document.querySelectorAll(".sev-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        document.getElementById("manualReportSeverity").value = pill.dataset.sev;
      });
    });

    if (reportForm) {
      reportForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        await this.handleManualReportSubmit();
      });
    }

    // Detail Drawer Close
    const closeDrawerBtn = document.getElementById("closeDrawerBtn");
    if (closeDrawerBtn) {
      closeDrawerBtn.addEventListener("click", () => {
        document.getElementById("detailDrawer").classList.remove("open");
      });
    }

    // Presentation Demo Tour Modal
    const openDemoTourBtn = document.getElementById("openDemoTourBtn");
    const closeDemoTourBtn = document.getElementById("closeDemoTourBtn");
    const demoTourModal = document.getElementById("demoTourModal");

    if (openDemoTourBtn) {
      openDemoTourBtn.addEventListener("click", () => {
        demoTourModal.classList.add("open");
      });
    }

    if (closeDemoTourBtn) {
      closeDemoTourBtn.addEventListener("click", () => {
        demoTourModal.classList.remove("open");
      });
    }

    // Reset Data Button
    const resetDataBtn = document.getElementById("resetDataBtn");
    if (resetDataBtn) {
      resetDataBtn.addEventListener("click", async () => {
        if (confirm("Reset prototype database to original seeded hackathon issues?")) {
          await API.resetData();
          await this.refreshAll();
          this.showToast("🔄 Database restored to default seed state.");
        }
      });
    }
  }

  switchView(viewName) {
    this.currentView = viewName;

    document.querySelectorAll(".nav-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    document.getElementById("viewDriver").classList.toggle("active", viewName === "driver");
    document.getElementById("viewGov").classList.toggle("active", viewName === "gov");

    if (viewName === "gov") {
      this.mapController.invalidateSize();
    }
  }

  async refreshAll() {
    await Promise.all([this.loadIssues(), this.loadStats()]);
  }

  async loadIssues() {
    try {
      const data = await API.getIssues(this.filters);
      this.issues = data.issues || [];
      this.renderQueueList(this.issues);
      this.renderRecentDriverList(this.issues);
      this.mapController.renderMarkers(this.issues);
    } catch (err) {
      console.error("Failed loading issues:", err);
    }
  }

  async loadStats() {
    try {
      const stats = await API.getStats();
      document.getElementById("kpiTotal").innerText = stats.total_issues;
      document.getElementById("kpiCritical").innerText = stats.critical_count;
      document.getElementById("kpiClusters").innerText = stats.clusters_count;
      document.getElementById("kpiInRepair").innerText = stats.in_repair_count;
      document.getElementById("kpiResolved").innerText = stats.resolved_count;
    } catch (err) {
      console.error("Failed loading stats:", err);
    }
  }

  applyFilters() {
    this.loadIssues();
  }

  renderQueueList(issues) {
    const container = document.getElementById("queueListContainer");
    if (!container) return;

    if (issues.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: var(--text-dim);">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">🔍</div>
          <p>No road issues match current filters.</p>
        </div>
      `;
      return;
    }

    let html = "";
    issues.forEach((issue) => {
      const isSelected = this.selectedIssue && this.selectedIssue.id === issue.id;
      const typeGlyphs = {
        pothole: "🕳️ Pothole",
        harsh_braking: "🛑 Braking Hotspot",
        sharp_swerve: "🔀 Swerve Hazard"
      };

      const clusterTag = issue.report_count > 1
        ? `<span class="tag tag-cluster" title="Corroborated by ${issue.report_count} separate vehicle trips">⚡ ${issue.report_count} Trips Corroborated</span>`
        : `<span class="tag" style="background: rgba(148,163,184,0.1); color: #94a3b8;">1 Trip Report</span>`;

      html += `
        <div class="issue-card ${isSelected ? "selected" : ""}" id="card-${issue.id}" onclick="window.App.selectIssueById('${issue.id}')">
          <div class="issue-card-top">
            <span class="issue-type-badge badge-${issue.type.split("_")[0]}">${typeGlyphs[issue.type] || issue.type}</span>
            <span class="status-pill status-${issue.status}">${(issue.status || "reported").replace("_", " ")}</span>
          </div>
          <div class="issue-card-title">${issue.title}</div>
          <div class="issue-card-loc">
            <span>📍</span>
            <span>${issue.location?.street || "Corridor"}, ${issue.location?.neighborhood || ""}</span>
          </div>
          <div class="issue-card-footer">
            <div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
              <span class="tag tag-${issue.severity}">${issue.severity}</span>
              <span class="tag" style="background: rgba(56,189,248,0.15); color: #38bdf8; font-weight: 700;">${issue.confidence}% Conf</span>
              ${clusterTag}
            </div>
            <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); window.App.openDetailDrawer('${issue.id}')">
              Inspect
            </button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  renderRecentDriverList(issues) {
    const container = document.getElementById("driverRecentIssues");
    if (!container) return;

    const recent = issues.slice(0, 5);
    let html = "";

    recent.forEach((issue) => {
      const typeGlyphs = { pothole: "🕳️", harsh_braking: "🛑", sharp_swerve: "🔀" };
      html += `
        <div class="recent-issue-item" onclick="window.App.switchView('gov'); window.App.selectIssueById('${issue.id}')">
          <div style="display: flex; align-items: center; gap: 0.65rem;">
            <div style="font-size: 1.3rem;">${typeGlyphs[issue.type] || "⚠️"}</div>
            <div>
              <div style="font-size: 0.88rem; font-weight: 600; color: #fff;">${issue.title}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${issue.location?.street || "Corridor"}</div>
            </div>
          </div>
          <div style="text-align: right;">
            <span class="tag tag-${issue.severity}">${issue.severity}</span>
            <div style="font-size: 0.72rem; color: var(--brand-glow); margin-top: 0.2rem;">${issue.report_count} Corroborations</div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  selectIssueById(issueId) {
    const issue = this.issues.find((i) => i.id === issueId);
    if (issue) this.selectIssue(issue, true);
  }

  selectIssue(issue, panMap = true) {
    this.selectedIssue = issue;

    // Highlight card in queue
    document.querySelectorAll(".issue-card").forEach((c) => c.classList.remove("selected"));
    const cardEl = document.getElementById(`card-${issue.id}`);
    if (cardEl) {
      cardEl.classList.add("selected");
      cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    if (panMap) {
      this.mapController.selectMarker(issue.id, true);
    }
  }

  async openDetailDrawer(issueId) {
    try {
      const issue = await API.getIssueDetail(issueId);
      this.selectedIssue = issue;
      this.renderDetailDrawer(issue);

      const drawer = document.getElementById("detailDrawer");
      drawer.classList.add("open");

      // Draw detailed sensor waveform sample
      setTimeout(() => {
        this.drawDetailWaveform(issue.telemetry?.waveform_sample || []);
      }, 100);
    } catch (err) {
      console.error("Failed to load issue detail:", err);
    }
  }

  renderDetailDrawer(issue) {
    document.getElementById("drawerIssueId").innerText = issue.id;
    document.getElementById("drawerTitle").innerText = issue.title;
    document.getElementById("drawerLocation").innerText = `${issue.location?.street}, ${issue.location?.neighborhood}, ${issue.location?.city}`;
    document.getElementById("drawerCoords").innerText = `Lat: ${issue.location?.lat.toFixed(5)}, Lng: ${issue.location?.lng.toFixed(5)}`;

    // Badges
    const badgeContainer = document.getElementById("drawerBadges");
    badgeContainer.innerHTML = `
      <span class="tag tag-${issue.severity}">${issue.severity.toUpperCase()} SEVERITY</span>
      <span class="tag tag-cluster">${issue.report_count} VEHICLE CORROBORATIONS</span>
      <span class="tag" style="background: rgba(56,189,248,0.2); color: #38bdf8; font-weight:700;">${issue.confidence}% CONFIDENCE (${issue.confidence_level.toUpperCase()})</span>
    `;

    // Stepper Pipeline
    const stages = ["reported", "under_review", "scheduled", "in_progress", "resolved"];
    const currentIdx = stages.indexOf(issue.status);

    stages.forEach((st, idx) => {
      const node = document.getElementById(`step-${st}`);
      if (!node) return;
      node.classList.remove("active", "completed");
      if (idx < currentIdx) node.classList.add("completed");
      else if (idx === currentIdx) node.classList.add("active");
    });

    // Work Order Inputs
    document.getElementById("woDept").value = issue.work_order?.assigned_dept || "Central Public Works";
    document.getElementById("woCrew").value = issue.work_order?.assigned_crew || "Rapid Response Squad";
    document.getElementById("woPriority").value = issue.work_order?.priority || "P1 - Urgent";
    document.getElementById("woNotes").value = issue.work_order?.notes || "";

    // Corroborated Reports Timeline
    const timelineContainer = document.getElementById("drawerReportsTimeline");
    let tHtml = "";
    (issue.reports || []).forEach((rep) => {
      const timeStr = new Date(rep.timestamp).toLocaleString();
      const isSensor = rep.source === "simulated_sensor";
      const sourceBadge = isSensor
        ? `<span style="color: #38bdf8; font-weight: 700;">⚡ Telemetry Auto-Detection (${rep.peak_g}G)</span>`
        : `<span style="color: #a78bfa; font-weight: 700;">👤 Driver Manual Report</span>`;

      tHtml += `
        <div class="timeline-item">
          <div class="timeline-item-meta">
            <span>${rep.report_id} • ${rep.trip_id}</span>
            <span>${timeStr}</span>
          </div>
          <div>${sourceBadge} • <em>${rep.device_type}</em></div>
          <div style="margin-top: 0.25rem; color: #cbd5e1;">"${rep.user_comment || "Anomaly registered"}"</div>
        </div>
      `;
    });
    timelineContainer.innerHTML = tHtml;

    // Action Buttons
    const actionsContainer = document.getElementById("drawerActionBtns");
    actionsContainer.innerHTML = `
      <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button class="btn btn-secondary btn-sm" onclick="window.App.updateIssueStatusAction('${issue.id}', 'under_review')">Mark Under Review</button>
        <button class="btn btn-primary btn-sm" onclick="window.App.updateIssueStatusAction('${issue.id}', 'scheduled')">Schedule Repair Squad</button>
        <button class="btn btn-secondary btn-sm" onclick="window.App.updateIssueStatusAction('${issue.id}', 'in_progress')">Mark In Progress</button>
        <button class="btn btn-success btn-sm" onclick="window.App.updateIssueStatusAction('${issue.id}', 'resolved')">✓ Confirm Repaired & Close</button>
      </div>
    `;
  }

  drawDetailWaveform(sample) {
    const canvas = document.getElementById("detailWaveformCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    const midY = h / 2;

    // Grid lines
    ctx.strokeStyle = "rgba(51, 65, 85, 0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    if (!sample || sample.length === 0) {
      sample = [1.0, 1.1, 2.5, 3.8, -1.2, 1.5, 1.0];
    }

    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    const step = w / (sample.length - 1);
    for (let i = 0; i < sample.length; i++) {
      const g = sample[i];
      const y = midY - (g - 1.0) * (h / 5);
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Data points
    for (let i = 0; i < sample.length; i++) {
      const g = sample[i];
      const y = midY - (g - 1.0) * (h / 5);
      const x = i * step;
      ctx.fillStyle = Math.abs(g - 1.0) > 1.5 ? "#ef4444" : "#f59e0b";
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  async updateIssueStatusAction(issueId, newStatus) {
    try {
      const notes = document.getElementById("woNotes").value;
      const crew = document.getElementById("woCrew").value;
      const priority = document.getElementById("woPriority").value;

      const res = await API.updateStatus(issueId, {
        status: newStatus,
        notes: notes,
        assigned_crew: crew,
        priority: priority
      });

      this.showToast(`✅ Status updated to: ${newStatus.replace("_", " ").toUpperCase()}`);
      await this.refreshAll();
      await this.openDetailDrawer(issueId);
    } catch (err) {
      console.error("Status update error:", err);
      alert("Failed to update status");
    }
  }

  async handleSimulatedDetection(event) {
    try {
      const payload = {
        type: event.type,
        severity: event.severity,
        lat: event.lat,
        lng: event.lng,
        street: event.street,
        neighborhood: event.neighborhood,
        source: "simulated_sensor",
        peak_g: event.peak_g
      };

      const res = await API.submitReport(payload);
      if (!res.is_new_cluster) {
        this.showToast(`⚡ Cluster Corroborated! #${res.issue.id} now has ${res.corroboration_count} reports (${res.new_confidence}% confidence).`);
      } else {
        this.showToast(`⚡ New road anomaly registered: #${res.issue.id}`);
      }

      await this.refreshAll();
    } catch (err) {
      console.error("Detection handling error:", err);
    }
  }

  async handleManualReportSubmit() {
    const type = document.getElementById("manualReportType").value;
    const severity = document.getElementById("manualReportSeverity").value;
    const street = document.getElementById("manualReportStreet").value.trim() || "Reported Corridor";
    const comment = document.getElementById("manualReportNotes").value.trim();

    const payload = {
      type: type,
      severity: severity,
      street: street,
      lat: 12.9719 + (Math.random() - 0.5) * 0.003, // close to corridor to demonstrate clustering
      lng: 77.5937 + (Math.random() - 0.5) * 0.003,
      source: "manual_driver",
      comment: comment
    };

    try {
      const res = await API.submitReport(payload);
      document.getElementById("reportModal").classList.remove("open");
      document.getElementById("manualReportNotes").value = "";

      if (!res.is_new_cluster) {
        this.showToast(`🎯 Report matched existing hazard cluster on ${res.issue.location.street}! Confidence raised to ${res.new_confidence}%.`);
      } else {
        this.showToast(`📍 New road hazard logged on ${street}!`);
      }

      await this.refreshAll();
    } catch (err) {
      console.error("Submission failed:", err);
      alert("Failed to submit report");
    }
  }

  showToast(message) {
    let toast = document.getElementById("appToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "appToast";
      toast.style.position = "fixed";
      toast.style.bottom = "20px";
      toast.style.right = "20px";
      toast.style.background = "#1e293b";
      toast.style.color = "#fff";
      toast.style.border = "1px solid #38bdf8";
      toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.6)";
      toast.style.padding = "0.75rem 1.25rem";
      toast.style.borderRadius = "8px";
      toast.style.fontSize = "0.85rem";
      toast.style.fontWeight = "600";
      toast.style.zIndex = "3000";
      toast.style.transition = "opacity 0.3s ease";
      document.body.appendChild(toast);
    }

    toast.innerText = message;
    toast.style.opacity = "1";
    toast.style.display = "block";

    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => { toast.style.display = "none"; }, 300);
    }, 4500);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.App = new RoadSenseApp();
  window.App.init();
});
