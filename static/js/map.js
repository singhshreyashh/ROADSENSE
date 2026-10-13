/**
 * RoadSense Geospatial Map Controller
 *
 * Technical Specification:
 * ------------------------
 * Implements a high-performance interactive mapping surface using Leaflet (v1.9.4)
 * with base tiles sourced from OpenStreetMap and CartoDB.
 *
 * Core Capabilities:
 *  1. Custom SVG Glyph Markers: Distinct icons for potholes, harsh braking, and swerves.
 *  2. Severity Spectrum Borders: Color-coded borders matching municipal urgency (Critical -> Low).
 *  3. Dynamic Cluster Badging: Corroborated multi-trip locations display an active count badge (Nx).
 *  4. Configurable Tile Providers: Dynamic basemap switching without re-instantiating the map canvas.
 *  5. Graceful Tile Fault Tolerance: Catches tile loading network timeouts and shows a non-blocking fallback banner.
 *  6. Bidirectional Synchronization: Synchronizes marker click events with the triage queue table and vice-versa.
 */

class RoadSenseMap {
  constructor(mapContainerId, options = {}) {
    this.containerId = mapContainerId;
    this.map = null;
    this.currentTileLayer = null;
    this.markersLayerGroup = null;
    this.markersMap = new Map(); // issueId -> L.marker instance
    this.selectedIssueId = null;
    this.onMarkerSelectCallback = options.onMarkerSelect || null;
    this.tileProviders = {};
    this.currentProviderKey = "openstreetmap";
    this.tileErrorCount = 0;
  }

  /**
   * Initializes the Leaflet map instance and default base layer.
   * Defaults to Bengaluru Central Business District (lat: 12.9716, lng: 77.5946).
   */
  async init(defaultCenter = [12.9716, 77.5946], defaultZoom = 13) {
    if (this.map) return;

    // Instantiate map with native zoom controls and OSM attribution
    this.map = L.map(this.containerId, {
      center: defaultCenter,
      zoom: defaultZoom,
      zoomControl: true,
      attributionControl: true
    });

    // Dedicated layer group for efficient batch marker clears and re-renders
    this.markersLayerGroup = L.layerGroup().addTo(this.map);

    // Fetch configurable tile providers from backend API
    try {
      const config = await API.getTileConfig();
      this.tileProviders = config.providers;
      this.setTileProvider("openstreetmap");
    } catch (err) {
      console.warn("Could not fetch tile config from backend, falling back to default OSM:", err);
      this.tileProviders = {
        openstreetmap: {
          url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
          maxZoom: 19
        }
      };
      this.setTileProvider("openstreetmap");
    }

    // Invalidate map dimensions once container layout finishes rendering
    setTimeout(() => {
      this.map.invalidateSize();
    }, 250);
  }

  /**
   * Switches the active cartographic basemap provider.
   * Manages attribution swap, tile cache cleanup, and network error counters.
   */
  setTileProvider(providerKey) {
    if (!this.tileProviders[providerKey]) {
      console.error(`Tile provider '${providerKey}' not registered in configuration`);
      return;
    }

    const provider = this.tileProviders[providerKey];
    this.currentProviderKey = providerKey;

    // Safely remove prior tile layer
    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
    }

    this.tileErrorCount = 0;
    const offlineBanner = document.getElementById("mapOfflineBanner");
    if (offlineBanner) offlineBanner.style.display = "none";

    this.currentTileLayer = L.tileLayer(provider.url, {
      maxZoom: provider.maxZoom || 19,
      attribution: provider.attribution || '&copy; OpenStreetMap contributors'
    });

    // Detect tile loading network failures (e.g. offline demo or proxy block)
    this.currentTileLayer.on("tileerror", (error) => {
      this.tileErrorCount++;
      // If repeated tile requests fail, display friendly warning without blocking the UI
      if (this.tileErrorCount > 4 && offlineBanner) {
        offlineBanner.style.display = "block";
      }
    });

    this.currentTileLayer.addTo(this.map);
  }

  /**
   * Renders road hazard markers on the map canvas.
   * Uses L.divIcon with custom HTML/SVG for crisp resolution on high-DPI retina screens.
   */
  renderMarkers(issues = []) {
    if (!this.markersLayerGroup) return;

    this.markersLayerGroup.clearLayers();
    this.markersMap.clear();

    const bounds = [];

    issues.forEach((issue) => {
      const lat = issue.location?.lat;
      const lng = issue.location?.lng;
      if (!lat || !lng) return;

      const markerIcon = this.createCustomMarkerIcon(issue);
      const marker = L.marker([lat, lng], { icon: markerIcon });

      // Build contextual popup card
      const popupHtml = this.buildPopupHtml(issue);
      marker.bindPopup(popupHtml, { minWidth: 240, maxWidth: 300 });

      // Click listener for bidirectional synchronization
      marker.on("click", () => {
        this.selectMarker(issue.id, false);
        if (this.onMarkerSelectCallback) {
          this.onMarkerSelectCallback(issue);
        }
      });

      marker.addTo(this.markersLayerGroup);
      this.markersMap.set(issue.id, marker);
      bounds.push([lat, lng]);
    });

    // Adjust camera viewport to encompass all visible markers unless user focused an issue
    if (bounds.length > 0 && !this.selectedIssueId) {
      try {
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      } catch (e) {
        // Safe fallback if bounds are identical
      }
    }
  }

  /**
   * Generates custom HTML markup for map pins based on type, severity, and cluster density.
   */
  createCustomMarkerIcon(issue) {
    const type = issue.type; // pothole | harsh_braking | sharp_swerve
    const severity = issue.severity || "medium";
    const reportCount = issue.report_count || 1;
    const isCluster = issue.is_cluster || reportCount > 1;

    let iconGlyph = "🕳️";
    let typeClass = "pothole";
    if (type === "harsh_braking") {
      iconGlyph = "🛑";
      typeClass = "braking";
    } else if (type === "sharp_swerve") {
      iconGlyph = "🔀";
      typeClass = "swerve";
    }

    // Cluster count badge indicating multi-trip corroboration
    const clusterBadgeHtml = isCluster
      ? `<span class="rs-cluster-count" title="${reportCount} Corroborating Vehicle Trips">${reportCount}x</span>`
      : "";

    // Severity border mapping matching municipal triage guidelines
    const sevColors = {
      critical: "#dc2626",
      high: "#ea580c",
      medium: "#f59e0b",
      low: "#10b981"
    };
    const borderColor = sevColors[severity] || "#f59e0b";

    const html = `
      <div class="rs-marker-icon" id="marker-${issue.id}">
        <div class="rs-pin ${typeClass}" style="border-color: ${borderColor};">
          <span>${iconGlyph}</span>
        </div>
        ${clusterBadgeHtml}
      </div>
    `;

    return L.divIcon({
      html: html,
      className: "custom-leaflet-pin",
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -20]
    });
  }

  /**
   * Constructs the HTML popup displayed upon marker click.
   */
  buildPopupHtml(issue) {
    const typeLabel = issue.type.replace("_", " ").toUpperCase();
    const statusLabel = (issue.status || "reported").replace("_", " ");

    return `
      <div class="popup-box">
        <div class="popup-title">${issue.title || "Road Hazard"}</div>
        <div class="popup-meta">
          <strong>${issue.location?.street || "Corridor"}</strong><br/>
          <span style="color: var(--text-dim);">${issue.location?.neighborhood || ""}</span>
        </div>
        <div style="display: flex; gap: 0.4rem; margin-bottom: 0.65rem; flex-wrap: wrap;">
          <span class="tag tag-${issue.severity}">${issue.severity}</span>
          <span class="tag tag-cluster">${issue.report_count} Reports</span>
          <span class="tag" style="background: rgba(56,189,248,0.15); color: #38bdf8;">${issue.confidence}% Conf</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 0.5rem;">
          <span class="status-pill status-${issue.status}">${statusLabel}</span>
          <button class="btn btn-primary btn-sm" onclick="window.App.openDetailDrawer('${issue.id}')">Inspect & Triage</button>
        </div>
      </div>
    `;
  }

  /**
   * Programmatically focuses and highlights a specific marker.
   */
  selectMarker(issueId, panTo = true) {
    this.selectedIssueId = issueId;
    const marker = this.markersMap.get(issueId);
    if (!marker) return;

    if (panTo) {
      this.map.panTo(marker.getLatLng(), { animate: true, duration: 0.5 });
      marker.openPopup();
    }
  }

  /**
   * Re-evaluates container geometry. Called when switching from Driver tab to Government tab.
   */
  invalidateSize() {
    if (this.map) {
      setTimeout(() => this.map.invalidateSize(), 200);
    }
  }
}

window.RoadSenseMap = RoadSenseMap;
