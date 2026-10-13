/**
 * RoadSense Mobile Kinematics & Sensor Simulation Engine
 *
 * Technical Specification:
 * ------------------------
 * Simulates high-resolution passive inertial measurement unit (IMU) telemetry
 * as would be captured by a smartphone mounted inside a vehicle or carried by a two-wheeler rider.
 *
 * Tracked Physical Dimensions:
 *  - Vertical Acceleration (Gz): Baseline ~1.00G (Earth gravity), with asphalt texture jitter (±0.06G).
 *    A severe pothole impact induces a sharp positive compression spike (>3.0G) followed by rebound (<0.0G).
 *  - Longitudinal Acceleration (Gx): Baseline ~0.0G during steady cruise.
 *    Emergency braking causes a negative deceleration trough (-0.6G to -0.9G).
 *  - Yaw Angular Velocity: Degrees/sec lateral rotation. Evasive swerves cause sharp bipolar excursions.
 *  - Sampling Rate: 10Hz (100ms discrete interval), reflecting mobile background sensing efficiency.
 *  - Rolling Canvas Buffer: 120-sample sliding window visualized in real-time on an HTML5 canvas.
 */

class SensorSimulator {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.isActive = true;
    this.onAnomalyDetected = options.onAnomalyDetected || null;
    
    // Rolling 120-sample waveform buffer initialized to 1.0G (standard gravitational rest state)
    this.waveHistory = new Array(120).fill(1.0);
    this.currentGz = 1.0;
    this.currentGx = 0.0;
    this.currentYaw = 0.0;
    this.currentSpeed = 42.0; // km/h
    this.gpsAccuracy = 3.2;   // meters

    this.simInterval = null;
    this.animFrameId = null;

    // Simulated corridor coordinates (along Bengaluru MG Road transit spine)
    this.currentSimCoords = {
      lat: 12.9719,
      lng: 77.5937,
      street: "MG Road near Metro Pillar 124",
      neighborhood: "Central Business District"
    };

    this.init();
  }

  /**
   * Initializes continuous telemetry sampling and canvas animation loop.
   */
  init() {
    this.startSimulation();
    this.renderLoop();
  }

  /**
   * Starts the 10Hz periodic IMU sampling interval.
   */
  startSimulation() {
    this.isActive = true;
    if (this.simInterval) clearInterval(this.simInterval);

    this.simInterval = setInterval(() => {
      if (!this.isActive) return;

      // Model micro-vibrations from aggregate road surface roughness
      const roadJitter = (Math.random() - 0.5) * 0.12;
      this.currentGz = 1.0 + roadJitter;
      this.currentGx = (Math.random() - 0.5) * 0.06;
      this.currentYaw = (Math.random() - 0.5) * 1.5;
      
      // Minor velocity drift around cruise speed
      this.currentSpeed = Math.max(25, Math.min(55, this.currentSpeed + (Math.random() - 0.5) * 1.2));
      
      // Realistic urban GPS multi-path variance (±3.0m to ±3.5m)
      this.gpsAccuracy = +(3.0 + Math.random() * 0.5).toFixed(1);

      // Slide buffer window
      this.waveHistory.push(this.currentGz);
      if (this.waveHistory.length > 120) this.waveHistory.shift();

      this.updateHudDom();
    }, 100);

    const pulseDot = document.getElementById("sensingPulseDot");
    const statusText = document.getElementById("sensingStatusText");
    if (pulseDot) pulseDot.classList.remove("paused");
    if (statusText) statusText.innerText = "ACTIVE — STREAMING 10Hz SIMULATED TELEMETRY";
  }

  /**
   * Halts background telemetry streaming (e.g. driver pauses trip).
   */
  pauseSimulation() {
    this.isActive = false;
    const pulseDot = document.getElementById("sensingPulseDot");
    const statusText = document.getElementById("sensingStatusText");
    if (pulseDot) pulseDot.classList.add("paused");
    if (statusText) statusText.innerText = "PAUSED — SENSING IDLE";
  }

  /**
   * Toggles sensing state between active streaming and idle pause.
   */
  toggleSimulation() {
    if (this.isActive) {
      this.pauseSimulation();
    } else {
      this.startSimulation();
    }
    return this.isActive;
  }

  /**
   * Injects an intentional shockwave anomaly into the telemetry stream
   * to demonstrate automated defect detection during live presentation.
   */
  triggerSimulatedAnomaly(type = "pothole") {
    let peakVal = 3.85;
    if (type === "harsh_braking") peakVal = 0.88;
    if (type === "sharp_swerve") peakVal = 0.95;

    // Inject transient kinematic shock pattern into rolling buffer
    if (type === "pothole") {
      this.waveHistory.push(2.2);   // Initial upward lip impact
      this.waveHistory.push(peakVal); // Maximum suspension compression
      this.waveHistory.push(-1.4);  // Wheel drop rebound into cavity
      this.waveHistory.push(1.6);   // Secondary chassis oscillation
      this.currentGz = peakVal;
    } else if (type === "harsh_braking") {
      this.currentGx = -peakVal;
      this.waveHistory.push(-0.4);
      this.waveHistory.push(-peakVal);
      this.waveHistory.push(-0.6);
    } else {
      this.currentYaw = 28.5;
      this.waveHistory.push(1.8);
      this.waveHistory.push(-1.5);
    }

    this.updateHudDom();

    // Dispatch event to aggregator listener
    if (this.onAnomalyDetected) {
      this.onAnomalyDetected({
        type: type,
        peak_g: peakVal,
        lat: this.currentSimCoords.lat,
        lng: this.currentSimCoords.lng,
        street: this.currentSimCoords.street,
        neighborhood: this.currentSimCoords.neighborhood,
        source: "simulated_sensor",
        severity: peakVal > 3.2 ? "critical" : "high"
      });
    }
  }

  /**
   * Updates numerical readouts in the Driver HUD display.
   */
  updateHudDom() {
    const gzEl = document.getElementById("hudGz");
    const gxEl = document.getElementById("hudGx");
    const speedEl = document.getElementById("hudSpeed");
    const gpsEl = document.getElementById("hudGps");

    if (gzEl) gzEl.innerText = `${this.currentGz.toFixed(2)} G`;
    if (gxEl) gxEl.innerText = `${this.currentGx.toFixed(2)} G`;
    if (speedEl) speedEl.innerText = `${this.currentSpeed.toFixed(0)} km/h`;
    if (gpsEl) gpsEl.innerText = `±${this.gpsAccuracy}m`;
  }

  /**
   * High-frequency 60fps render loop for smooth waveform canvas rendering.
   */
  renderLoop() {
    if (this.ctx && this.canvas) {
      this.drawWaveform();
    }
    this.animFrameId = requestAnimationFrame(() => this.renderLoop());
  }

  /**
   * Draws the rolling vertical accelerometer wave on the HTML5 canvas.
   */
  drawWaveform() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // Draw baseline 1.0G gravitational datum line
    const midY = h / 2;
    ctx.strokeStyle = "rgba(51, 65, 85, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Draw continuous waveform trace
    ctx.strokeStyle = this.isActive ? "#38bdf8" : "#64748b";
    ctx.lineWidth = 2;
    ctx.beginPath();

    const step = w / (this.waveHistory.length - 1);
    for (let i = 0; i < this.waveHistory.length; i++) {
      const g = this.waveHistory[i];
      // Scale G-force deviation relative to 1.0G center datum
      const y = midY - (g - 1.0) * (h / 4);
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Pulse dot at the trailing edge representing the instantaneous sensor measurement
    const lastG = this.waveHistory[this.waveHistory.length - 1];
    const lastY = midY - (lastG - 1.0) * (h / 4);
    ctx.fillStyle = Math.abs(lastG - 1.0) > 1.2 ? "#ef4444" : "#38bdf8";
    ctx.beginPath();
    ctx.arc(w - 4, lastY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

window.SensorSimulator = SensorSimulator;
