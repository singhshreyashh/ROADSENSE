/**
 * RoadSense Civic REST API Client
 *
 * Encapsulates all asynchronous HTTP client interactions with the Flask backend.
 * Provides clean asynchronous methods for:
 *  - Defect clustering queries with multi-criteria filtering
 *  - Real-time report ingestion (manual citizen inputs and simulated IMU spikes)
 *  - Municipal lifecycle transitions (inspection -> schedule -> resolution)
 *  - KPI aggregations and basemap configuration retrieval
 */

const API = {
  /**
   * Queries road defect clusters matching optional filter parameters.
   * @param {Object} params - Query filters { type, severity, confidence, status, search }
   * @returns {Promise<{ count: number, total: number, issues: Array }>}
   */
  async getIssues(params = {}) {
    const query = new URLSearchParams();
    if (params.type && params.type !== "all") query.append("type", params.type);
    if (params.severity && params.severity !== "all") query.append("severity", params.severity);
    if (params.confidence && params.confidence !== "all") query.append("confidence", params.confidence);
    if (params.status && params.status !== "all") query.append("status", params.status);
    if (params.search) query.append("search", params.search);

    const url = `/api/issues?${query.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to retrieve road issues`);
    return await res.json();
  },

  /**
   * Fetches full inspection detail, corroborating trip logs, and sensor waveforms for a defect.
   * @param {string} issueId - Defect cluster identifier (e.g. 'RS-101')
   * @returns {Promise<Object>}
   */
  async getIssueDetail(issueId) {
    const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}`);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to retrieve defect detail for ${issueId}`);
    return await res.json();
  },

  /**
   * Ingests a new defect event (manual citizen submission or simulated vehicle shock).
   * Backend will match against spatial clusters within 120m or initialize a new cluster.
   * @param {Object} payload - { type, severity, lat, lng, street, source, comment, peak_g }
   * @returns {Promise<{ message: string, is_new_cluster: boolean, corroboration_count: number, new_confidence: number, issue: Object }>}
   */
  async submitReport(payload) {
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to dispatch hazard report`);
    return await res.json();
  },

  /**
   * Advances the municipal repair state and updates crew assignments or resolution audit notes.
   * @param {string} issueId - Defect cluster identifier
   * @param {Object} payload - { status, priority, assigned_crew, notes }
   * @returns {Promise<{ message: string, issue: Object }>}
   */
  async updateStatus(issueId, payload) {
    const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to update defect lifecycle status`);
    return await res.json();
  },

  /**
   * Retrieves high-level civic KPIs for the dashboard header.
   * @returns {Promise<{ total_issues: number, critical_count: number, clusters_count: number, in_repair_count: number, resolved_count: number, by_type: Object }>}
   */
  async getStats() {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to retrieve aggregate statistics`);
    return await res.json();
  },

  /**
   * Fetches supported Leaflet basemap providers, URL templates, and legal attributions.
   * @returns {Promise<{ default: string, providers: Object }>}
   */
  async getTileConfig() {
    const res = await fetch("/api/tile-config");
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to retrieve tile provider configuration`);
    return await res.json();
  },

  /**
   * Restores the in-memory dataset to the initial hackathon seed state.
   * @returns {Promise<{ message: string, count: number }>}
   */
  async resetData() {
    const res = await fetch("/api/reset", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Failed to reset dataset`);
    return await res.json();
  }
};

window.API = API;
