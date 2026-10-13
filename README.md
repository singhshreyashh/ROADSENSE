# RoadSense 🛣️
### Crowdsourced Civic Road-Condition Mapping System (Hackathon Prototype)

RoadSense is a civic road-safety web platform that leverages crowdsourced smartphone motion telemetry and citizen hazard reports to detect road defects (potholes, harsh braking zones, and sharp evasive swerves). By clustering spatial anomalies across multiple independent trips, RoadSense turns noisy phone vibrations into high-confidence, actionable work orders for municipal public works departments.

---

## 🌟 Key Highlights & Demo Features

### 1. Driver Sensing Experience
- **Simulated 10Hz Smartphone HUD**: Live stream of vertical acceleration ($G_z$), longitudinal braking deceleration ($G_x$), speed, and GPS accuracy ($\pm 3.2\text{m}$).
- **Real-Time Accelerometer Waveform**: HTML5 Canvas rendering baseline vibrations with sharp impulse peaks.
- **Sensing Controls**: Start, pause, or inject simulated bump events with realistic $3.85G$ vertical shockwaves.
- **Manual Hazard Reporting**: Fast 1-tap modal to log craters, braking hazards, or swerves with severity ratings.
- **Civic Privacy Assurance**: Clear notice explaining passive motion analysis without persistent vehicle route tracking.

### 2. Intelligent Issue Processing & Spatial Clustering
- **Three Core Event Types**: Potholes / Depressions (🕳️), Harsh Braking (🛑), and Sharp Swerves (🔀).
- **Multi-Trip Corroboration Engine**: Matches incoming detections against spatial clusters ($\le 120\text{m}$).
- **Confidence vs. Severity Decoupling**: A single bump has low confidence ($42\%$), but $4+$ independent vehicles elevate confidence to $>90\%$ (High Confidence).
- **Visual Distinction**: Multi-corroborated clusters display dynamic badges (`5x`, `6x`) while single reports show `1x`.

### 3. Municipal Operations Dashboard & Interactive Map
- **Prominent Leaflet & OpenStreetMap Engine**: Interactive pan/zoom, custom SVG marker glyphs, severity halos, and cluster counts.
- **Synchronized Map & Triage Queue**: Selecting an issue on the map highlights and scrolls the queue card; clicking a queue card pans and opens the map popup.
- **Multi-Dimensional Filters**: Filter simultaneously by Type, Severity (Critical to Low), Confidence Level, Status, or search by street name.
- **Configurable Basemap Providers**: Toggle between OpenStreetMap Standard, CartoDB Positron (Civic Light), and CartoDB Dark Matter.
- **Offline / Failure Resilience**: Gracefully displays a non-blocking alert banner if map tiles fail to load, keeping triage and data 100% operational.

### 4. Municipal Triage & Repair Lifecycle
- **5-Stage Pipeline Stepper**: `Reported` $\rightarrow$ `Under Review` $\rightarrow$ `Scheduled for Repair` $\rightarrow$ `In Progress` $\rightarrow$ `Resolved`.
- **Sensor Evidence Visualizer**: Accelerometer impulse graph displaying the vertical shock peak ($G_z$).
- **Multi-Trip Timeline**: View individual vehicle trips, device mounts, timestamps, and comments corroborating the defect.
- **Work Order Management**: Assign public works departments, repair squads (e.g. Rapid Asphalt Patching Squad), dispatch priority, and resolution logs.

---

## 🚀 Quickstart Guide

### Prerequisites
- Python 3.10+ (Tested on Python 3.15)
- Standard Web Browser (Chrome, Firefox, Edge, Safari)

### 1. Installation
Clone or navigate to the repository:
```bash
cd MANTHAN
```

Install dependencies:
```bash
pip install -r requirements.txt
```

### 2. Run the Application
Start the Flask server:
```bash
python app.py
```

Open your browser and navigate to:
```
http://127.0.0.1:5000
```

---

## 🎯 4-Step Hackathon Presentation Walkthrough

Use this exact sequence to demonstrate the complete user journey in under 3 minutes:

1. **Step 1: Commuter Experience (Driver Portal)**
   - Click **Driver Sensing Portal** in the top navigation.
   - Show the live streaming HUD gauges and canvas waveform.
   - Click `⚡ Inject Pothole Bump` to simulate driving over a severe crater. Note the $3.85G$ spike and instant detection feedback.
2. **Step 2: Crowdsource Corroboration & Confidence Boosting**
   - Click `+ Report Road Hazard` and submit a report on *MG Road*.
   - Point out how the clustering engine groups this with previous trips, elevating confidence from $40\%$ to $94\%$. Explain how crowdsourcing eliminates false positives (like manholes or expansion joints).
3. **Step 3: Municipal Operations & Interactive Map**
   - Switch to **Public Works Dashboard**.
   - Explore the Leaflet map with custom marker shapes, severity borders, and cluster badges (`5x`).
   - Use the filter toolbar to filter by `Severity: Critical` or switch the basemap to `CartoDB Positron`.
4. **Step 4: Evidence Inspection & Repair Lifecycle**
   - Click `Inspect` on `#RS-101`.
   - In the slide-over drawer, inspect the accelerometer shockwave graph and corroborating trip logs.
   - Click `Schedule Repair Squad`, then `Confirm Repaired & Close`. Notice how the map pin and status update live!

*(Tip: Click `🔄 Reset Data` in the top right at any time to restore initial seed data for a fresh demo run).*

---

## 🏗️ Architecture & Project Structure

```
MANTHAN/
├── app.py                      # Flask backend, REST API & clustering engine
├── requirements.txt            # Python dependencies (flask)
├── README.md                   # Project documentation & presentation guide
├── data/
│   └── seed_issues.json        # Seeded realistic metro road defect clusters
├── templates/
│   └── index.html              # Responsive single-page application template
└── static/
    ├── css/
    │   └── style.css           # High-contrast civic design system
    └── js/
        ├── api.js              # REST client for backend endpoints
        ├── map.js              # Leaflet map manager, custom markers & tile config
        ├── sensor_sim.js       # Live telemetry generator & canvas waveform
        └── app.js              # UI controller, filters, modals & drawer workflow
```

---

## 📡 REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/issues` | Query road issues with filters (`type`, `severity`, `confidence`, `status`, `search`) |
| `GET` | `/api/issues/<id>` | Retrieve full defect details, telemetry sample, trip reports, and work order |
| `POST` | `/api/issues` | Submit new report; automatically matches spatial clusters ($\le 120\text{m}$) or creates new cluster |
| `PATCH` | `/api/issues/<id>/status` | Update municipal status (`reported`, `under_review`, `scheduled`, `in_progress`, `resolved`) |
| `GET` | `/api/stats` | Aggregated civic metrics (total, critical, clusters, in-repair, resolved) |
| `GET` | `/api/tile-config` | Configurable Leaflet tile providers and attributions |
| `POST` | `/api/reset` | Restore dataset to clean hackathon seed state |

---

## 🔒 Prototype Assumptions & Production Roadmap

- **Prototype Assumptions**: Mobile sensor telemetry is simulated via an interactive 10Hz algorithmic stream to allow reliable demonstrations without requiring physical driving or mobile hardware installations.
- **Production Sensor Ingestion**: Real iOS CoreMotion (`CMMotionManager`) and Android `SensorManager` event listeners streaming high-pass filtered accelerometer data over WebSockets or batch REST endpoints.
- **ML Anomaly Classification**: Multi-sensor classifier (e.g. Random Forest or XGBoost on vertical spectral density, vehicle speed, and gyro yaw rate) to distinguish potholes from speed bumps and railway tracks.
- **Geospatial Storage**: PostgreSQL with PostGIS extension (`ST_DWithin` spatial indexing) for scale across millions of city-wide trip traces.
