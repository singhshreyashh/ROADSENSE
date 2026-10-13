/**
 * RoadSense Mobile Kinematics & Sensor Fusion Engine
 *
 * Real Mobile Hardware Capture:
 * ------------------------------
 * Captures 3-axis Accelerometer (accelerationIncludingGravity),
 * Gyroscope (rotationRate / orientation), and continuous GPS (watchPosition)
 * directly from mobile browsers (Chrome on Android, Safari on iOS).
 *
 * Key Capabilities:
 *  1. Permission & Secure Context Handling:
 *     - Handles iOS Safari `DeviceMotionEvent.requestPermission()` via explicit user click gesture.
 *     - Detects non-secure contexts (`!window.isSecureContext`) and displays setup advice.
 *  2. Sensor Fusion & Live Telemetry:
 *     - Captures Gx, Gy, Gz (in m/s² and G) and Gyro (alpha, beta, gamma in deg/s).
 *     - High-accuracy GPS streaming (`enableHighAccuracy: true`, `timeout: 10000`).
 *  3. Pothole / Bump Detection with Debounce:
 *     - Filters vertical shock spikes (|acc.z| > 17.5 m/s² or |acc.z - 9.8| > 7.5 m/s²).
 *     - Enforces a 2.5-second cooldown to debounce multiple triggers for a single physical pothole.
 *     - Automatically dispatches `{ latitude, longitude, intensity, speed, timestamp }` to `/api/report`.
 *     - Triggers haptic vibration (`navigator.vibrate`) and Web Audio warning beep.
 *  4. Presentation Backup:
 *     - Manual simulate trigger button for desktop / stationary presentations.
 *     - Simulation fallback mode for browsers without IMU hardware.
 */

class MobileSensorEngine {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    
    // Callbacks
    this.onAnomalyDetected = options.onAnomalyDetected || null;
    this.onStatusChanged = options.onStatusChanged || null;

    // Tracking state
    this.isTracking = false;
    this.isHardwareMode = false;
    this.isSimulatedMode = false;
    this.hasReceivedHardwareEvents = false;

    // Hardware support & permissions
    this.isSecureContext = window.isSecureContext === true;
    this.hasMotionSupport = typeof window !== "undefined" && "DeviceMotionEvent" in window;
    this.hasOrientationSupport = typeof window !== "undefined" && "DeviceOrientationEvent" in window;
    this.hasGeoSupport = typeof navigator !== "undefined" && "geolocation" in navigator;

    // Cooldown & debouncing
    this.lastBumpTime = 0;
    this.cooldownMs = 2500; // 2.5 second cooldown between automated bump dispatches
    this.bumpThresholdMs2 = 17.5; // Shock threshold in m/s² (~1.78G)

    // Live telemetry buffers
    this.currentGz = 1.0;  // in G
    this.currentAz = 9.81; // in m/s²
    this.currentAx = 0.0;
    this.currentAy = 0.0;
    this.currentSpeed = 0.0; // km/h
    this.currentGyro = { alpha: 0, beta: 0, gamma: 0 };
    
    // GPS state (defaults to central Bengaluru corridor until resolved)
    this.currentGps = {
      lat: 12.9719,
      lng: 77.5937,
      accuracy: 5.0,
      speed: 0.0,
      resolved: false
    };

    // Rolling waveform buffer (120 samples visualized on canvas)
    this.waveHistory = new Array(120).fill(1.0);

    // Watch IDs & timers
    this.geoWatchId = null;
    this.simInterval = null;
    this.animFrameId = null;
    this.motionEventCount = 0;
    this.sampleRateHz = 0;
    this.sampleCountTimer = null;

    // Bound listeners for clean removal
    this.boundMotionHandler = (e) => this.handleDeviceMotion(e);
    this.boundOrientationHandler = (e) => this.handleDeviceOrientation(e);

    this.init();
  }

  init() {
    this.checkSecureContextBanner();
    this.renderLoop();
  }

  /**
   * Checks if running under a secure context (HTTPS / localhost).
   * Displays advice banner if sensors are blocked by mobile browser security policy.
   */
  checkSecureContextBanner() {
    const noticeEl = document.getElementById("secureContextNotice");
    if (!this.isSecureContext && noticeEl) {
      noticeEl.style.display = "block";
    }
  }

  /**
   * Explicit user gesture entry point.
   * Handles iOS 13+ DeviceMotionEvent.requestPermission() requirement.
   */
  async requestPermissions() {
    let motionGranted = false;

    // 1. iOS Safari DeviceMotionEvent Permission Request
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
      try {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission === "granted") {
          motionGranted = true;
        } else {
          console.warn("iOS Motion permission denied by user:", permission);
          alert("Motion sensor permission was not granted. Please enable Motion & Orientation access in Safari Settings.");
          return false;
        }
      } catch (err) {
        console.warn("DeviceMotionEvent.requestPermission error:", err);
      }
    } else {
      // Standard Android Chrome / other browsers (no explicit motion prompt needed)
      motionGranted = true;
    }

    // 2. iOS Safari DeviceOrientationEvent Permission Request
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        await DeviceOrientationEvent.requestPermission();
      } catch (e) {
        // Safe to ignore if motion is already granted
      }
    }

    return motionGranted;
  }

  /**
   * Starts live hardware tracking.
   * Falls back gracefully to simulation mode if on desktop or if hardware motion is absent.
   */
  async startTracking() {
    if (this.isTracking) return;

    // Request permissions (must be directly in user gesture chain)
    const permissionsGranted = await this.requestPermissions();
    if (!permissionsGranted && !confirm("Hardware motion sensors unavailable. Would you like to run in Simulation Mode?")) {
      return;
    }

    this.isTracking = true;
    this.hasReceivedHardwareEvents = false;
    this.motionEventCount = 0;

    // 1. Attach native hardware motion listeners
    if (this.hasMotionSupport) {
      window.addEventListener("devicemotion", this.boundMotionHandler, { passive: true });
    }
    if (this.hasOrientationSupport) {
      window.addEventListener("deviceorientation", this.boundOrientationHandler, { passive: true });
    }

    // 2. Start continuous high-accuracy Geolocation
    if (this.hasGeoSupport) {
      try {
        this.geoWatchId = navigator.geolocation.watchPosition(
          (pos) => this.handleGeoSuccess(pos),
          (err) => this.handleGeoError(err),
          {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 10000
          }
        );
      } catch (geoErr) {
        console.warn("Geolocation watchPosition error:", geoErr);
      }
    }

    // 3. Measure effective sampling rate
    this.sampleCountTimer = setInterval(() => {
      this.sampleRateHz = this.motionEventCount;
      this.motionEventCount = 0;
      this.updateHudDom();
    }, 1000);

    // 4. Verify whether real hardware events are actually streaming
    // (If user is on a desktop laptop, devicemotion won't fire)
    setTimeout(() => {
      if (!this.hasReceivedHardwareEvents && this.isTracking) {
        console.log("No hardware motion events detected after 2s. Enabling hybrid simulation fallback.");
        this.startSimulationFallback();
      } else {
        this.isHardwareMode = true;
        this.updateStatusBadge("active_hardware");
      }
    }, 2000);

    this.updateStatusBadge("active_hardware");
  }

  /**
   * Stops all active hardware listeners and timers.
   */
  stopTracking() {
    this.isTracking = false;
    this.isHardwareMode = false;
    this.isSimulatedMode = false;

    if (this.hasMotionSupport) {
      window.removeEventListener("devicemotion", this.boundMotionHandler);
    }
    if (this.hasOrientationSupport) {
      window.removeEventListener("deviceorientation", this.boundOrientationHandler);
    }

    if (this.geoWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this.geoWatchId);
      this.geoWatchId = null;
    }

    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }

    if (this.sampleCountTimer) {
      clearInterval(this.sampleCountTimer);
      this.sampleCountTimer = null;
    }

    this.updateStatusBadge("paused");
  }

  /**
   * Toggles between tracking and idle state.
   */
  async toggleTracking() {
    if (this.isTracking) {
      this.stopTracking();
      return false;
    } else {
      await this.startTracking();
      return true;
    }
  }

  /**
   * Handles incoming native DeviceMotionEvent from phone IMU.
   */
  handleDeviceMotion(event) {
    this.hasReceivedHardwareEvents = true;
    this.isHardwareMode = true;
    this.motionEventCount++;

    // Universal acceleration extraction (accelerationIncludingGravity works on all iOS & Android)
    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    const x = acc.x || 0.0;
    const y = acc.y || 0.0;
    const z = acc.z !== null && acc.z !== undefined ? acc.z : 9.81;

    this.currentAx = x;
    this.currentAy = y;
    this.currentAz = Math.abs(z);
    this.currentGz = this.currentAz / 9.80665; // Convert m/s² to G-force

    // Total 3D acceleration magnitude
    const mag = Math.sqrt(x * x + y * y + z * z);
    const deltaFromGravity = Math.abs(this.currentAz - 9.80665);

    // Extract angular rotation rate from gyroscope if present
    if (event.rotationRate) {
      this.currentGyro.alpha = event.rotationRate.alpha || 0;
      this.currentGyro.beta = event.rotationRate.beta || 0;
      this.currentGyro.gamma = event.rotationRate.gamma || 0;
    }

    // Append to rolling waveform history buffer
    this.waveHistory.push(this.currentGz);
    if (this.waveHistory.length > 120) this.waveHistory.shift();

    // ----------------------------------------
    // POTHOLE / BUMP DETECTION LOGIC
    // ----------------------------------------
    // Conditions for vertical road impact:
    //  1. Vertical shock exceeds threshold (e.g. > 17.5 m/s² or ~1.78G)
    //  2. OR large vertical deviation from gravity (> 7.5 m/s²)
    //  3. OR total combined 3D jerk magnitude exceeds 18.0 m/s²
    const isShock = (this.currentAz > this.bumpThresholdMs2) || (deltaFromGravity > 7.5) || (mag > 18.0);

    if (isShock) {
      const now = Date.now();
      // Enforce 2.5 second debouncing cooldown
      if (now - this.lastBumpTime > this.cooldownMs) {
        this.lastBumpTime = now;
        this.handleImpactDetected(this.currentAz, this.currentGz, "mobile_sensor");
      }
    }

    this.updateHudDom();
  }

  /**
   * Handles native DeviceOrientationEvent (compass, pitch, roll).
   */
  handleDeviceOrientation(event) {
    if (event.alpha !== null) this.currentGyro.alpha = event.alpha || 0;
    if (event.beta !== null) this.currentGyro.beta = event.beta || 0;
    if (event.gamma !== null) this.currentGyro.gamma = event.gamma || 0;
  }

  /**
   * Handles continuous GPS updates from navigator.geolocation.watchPosition.
   */
  handleGeoSuccess(position) {
    const coords = position.coords;
    this.currentGps.lat = coords.latitude;
    this.currentGps.lng = coords.longitude;
    this.currentGps.accuracy = Math.round(coords.accuracy || 3.0);
    this.currentGps.resolved = true;

    // Convert speed from m/s to km/h if available
    if (coords.speed !== null && coords.speed !== undefined && coords.speed >= 0) {
      this.currentSpeed = +(coords.speed * 3.6).toFixed(1);
    }

    this.updateHudDom();
  }

  handleGeoError(error) {
    console.warn("Geolocation warning:", error.message);
  }

  /**
   * Dispatches automated bump detection:
   *  1. Haptic vibration
   *  2. Audio synthesizer beep
   *  3. Visual UI pulse
   *  4. Automatic POST payload to `/api/report`
   */
  async handleImpactDetected(intensityMs2, peakG, source = "mobile_sensor") {
    // 1. Haptic feedback
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200]); } catch (e) {}
    }

    // 2. Synthesize audio warning beep via Web Audio API
    this.playAudioWarningBeep();

    // 3. Visual UI pulse
    this.flashImpactUi(intensityMs2, peakG);

    // 4. Package report payload
    const payload = {
      latitude: this.currentGps.lat,
      longitude: this.currentGps.lng,
      intensity: +intensityMs2.toFixed(2),
      peak_g: +peakG.toFixed(2),
      speed: +(this.currentSpeed || 0),
      timestamp: new Date().toISOString(),
      type: "pothole",
      severity: peakG > 2.5 ? "critical" : (peakG > 1.8 ? "high" : "medium"),
      source: source,
      comment: `Live mobile motion shock: ${intensityMs2.toFixed(1)} m/s² (${peakG.toFixed(2)}G)`
    };

    // 5. Send POST request to backend `/api/report`
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      // Trigger callback if registered
      if (this.onAnomalyDetected) {
        this.onAnomalyDetected(payload, data);
      }
    } catch (err) {
      console.error("Failed to dispatch live bump report to /api/report:", err);
    }
  }

  /**
   * Manual backup trigger button for presentations or testing without phone motion.
   */
  triggerManualSimulatedBump() {
    const peakG = 3.85;
    const intensityMs2 = peakG * 9.80665;

    // Inject transient shock into rolling waveform buffer
    this.waveHistory.push(2.2);
    this.waveHistory.push(peakG);
    this.waveHistory.push(-1.4);
    this.waveHistory.push(1.6);
    this.currentGz = peakG;
    this.currentAz = intensityMs2;

    this.handleImpactDetected(intensityMs2, peakG, "simulated_sensor");
  }

  /**
   * Plays a clean 880Hz audio warning beep using Web Audio API.
   */
  playAudioWarningBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    } catch (e) {
      // AudioContext policy fallback
    }
  }

  /**
   * Visual feedback flashing the HUD card border when a bump is detected.
   */
  flashImpactUi(intensityMs2, peakG) {
    const hudCard = document.querySelector(".driver-card");
    if (hudCard) {
      hudCard.classList.add("bump-flash");
      setTimeout(() => hudCard.classList.remove("bump-flash"), 1000);
    }

    const banner = document.getElementById("hudBumpAlertBanner");
    if (banner) {
      banner.innerText = `💥 BUMP DETECTED: ${intensityMs2.toFixed(1)} m/s² (${peakG.toFixed(2)}G) — Reported to City Map!`;
      banner.style.display = "block";
      setTimeout(() => { banner.style.display = "none"; }, 3500);
    }
  }

  /**
   * Fallback simulation loop for desktop browsers with no hardware accelerometer.
   */
  startSimulationFallback() {
    this.isSimulatedMode = true;
    this.isHardwareMode = false;
    this.updateStatusBadge("active_simulated");

    if (this.simInterval) clearInterval(this.simInterval);
    this.simInterval = setInterval(() => {
      if (!this.isTracking) return;

      const roadJitter = (Math.random() - 0.5) * 0.12;
      this.currentGz = 1.0 + roadJitter;
      this.currentAz = this.currentGz * 9.80665;
      this.currentAx = (Math.random() - 0.5) * 0.5;
      this.currentSpeed = Math.max(25, Math.min(55, this.currentSpeed + (Math.random() - 0.5) * 1.5));
      
      this.waveHistory.push(this.currentGz);
      if (this.waveHistory.length > 120) this.waveHistory.shift();

      this.updateHudDom();
    }, 100);
  }

  /**
   * Updates DOM status indicator badge.
   */
  updateStatusBadge(state) {
    const pulseDot = document.getElementById("sensingPulseDot");
    const statusText = document.getElementById("sensingStatusText");
    const modeBadge = document.getElementById("sensorModeBadge");

    if (!statusText || !pulseDot) return;

    if (state === "active_hardware") {
      pulseDot.className = "pulse-dot";
      statusText.innerText = "SENSORS ACTIVE: LIVE MOBILE HARDWARE";
      if (modeBadge) {
        modeBadge.innerText = "LIVE IMU + GPS";
        modeBadge.className = "tag tag-low";
      }
    } else if (state === "active_simulated") {
      pulseDot.className = "pulse-dot sim-pulse";
      statusText.innerText = "SENSORS ACTIVE: SIMULATION FALLBACK (Desktop Mode)";
      if (modeBadge) {
        modeBadge.innerText = "SIMULATED";
        modeBadge.className = "tag tag-medium";
      }
    } else {
      pulseDot.className = "pulse-dot paused";
      statusText.innerText = "TRACKING IDLE — TAP 'START TRACKING' TO BEGIN";
      if (modeBadge) {
        modeBadge.innerText = "IDLE";
        modeBadge.className = "tag";
      }
    }
  }

  /**
   * Updates numerical values on the HUD gauges.
   */
  updateHudDom() {
    const gzEl = document.getElementById("hudGz");
    const gxEl = document.getElementById("hudGx");
    const speedEl = document.getElementById("hudSpeed");
    const gpsEl = document.getElementById("hudGps");
    const gyroEl = document.getElementById("hudGyro");

    if (gzEl) {
      gzEl.innerHTML = `${this.currentAz.toFixed(1)} <span style="font-size:0.75rem;">m/s²</span> <span style="color:var(--text-muted); font-size:0.8rem;">(${this.currentGz.toFixed(2)}G)</span>`;
    }
    if (gxEl) {
      gxEl.innerText = `${this.currentAx.toFixed(2)} m/s²`;
    }
    if (speedEl) {
      speedEl.innerText = `${this.currentSpeed.toFixed(0)} km/h`;
    }
    if (gpsEl) {
      if (this.currentGps.resolved) {
        gpsEl.innerText = `${this.currentGps.lat.toFixed(5)}, ${this.currentGps.lng.toFixed(5)} (±${this.currentGps.accuracy}m)`;
      } else {
        gpsEl.innerText = `Searching GPS... (±${this.currentGps.accuracy}m)`;
      }
    }
    if (gyroEl) {
      gyroEl.innerText = `α:${this.currentGyro.alpha.toFixed(0)}° β:${this.currentGyro.beta.toFixed(0)}° γ:${this.currentGyro.gamma.toFixed(0)}°`;
    }
  }

  /**
   * Continuous animation loop rendering the live accelerometer wave.
   */
  renderLoop() {
    if (this.ctx && this.canvas) {
      this.drawWaveform();
    }
    this.animFrameId = requestAnimationFrame(() => this.renderLoop());
  }

  drawWaveform() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // Baseline 1.0G gravity datum line
    const midY = h / 2;
    ctx.strokeStyle = "rgba(51, 65, 85, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Trace line
    ctx.strokeStyle = this.isTracking ? (this.isHardwareMode ? "#10b981" : "#38bdf8") : "#64748b";
    ctx.lineWidth = 2.2;
    ctx.beginPath();

    const step = w / (this.waveHistory.length - 1);
    for (let i = 0; i < this.waveHistory.length; i++) {
      const g = this.waveHistory[i];
      const y = midY - (g - 1.0) * (h / 4);
      const x = i * step;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Pulse dot at current tip
    const lastG = this.waveHistory[this.waveHistory.length - 1];
    const lastY = midY - (lastG - 1.0) * (h / 4);
    ctx.fillStyle = Math.abs(lastG - 1.0) > 0.8 ? "#ef4444" : (this.isHardwareMode ? "#10b981" : "#38bdf8");
    ctx.beginPath();
    ctx.arc(w - 4, lastY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Export as both MobileSensorEngine and SensorSimulator for backward compatibility
window.MobileSensorEngine = MobileSensorEngine;
window.SensorSimulator = MobileSensorEngine;
