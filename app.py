"""
RoadSense — Civic Road-Condition Mapping System
Backend API & Application Server (Flask)

Architecture Note:
------------------
RoadSense ingests high-frequency motion anomaly events (vertical shock, longitudinal braking,
and evasive swerves) collected by commuter smartphones and aggregates them spatially.
Instead of relying on single unverified phone vibrations (which may be caused by expansion joints,
speed bumps, or device drops), the backend applies spatial deduplication and confidence scoring:
as multiple independent trips corroborate the same geographic coordinate cluster, statistical
confidence increases from provisional (<50%) to actionable (>80%), enabling municipal public works
teams to prioritize physical inspections and dispatch maintenance crews efficiently.
"""

import os
import json
import math
import copy
from datetime import datetime, timezone
from flask import Flask, jsonify, request, render_template, send_from_directory

# Initialize Flask application with static assets and HTML templates
app = Flask(__name__, static_folder="static", template_folder="templates")

# Path to persistent seed issues fixture
SEED_FILE = os.path.join(os.path.dirname(__file__), "data", "seed_issues.json")

# In-memory working database initialized from seed data
# Note: For production deployment, replace with PostgreSQL + PostGIS (ST_DWithin)
WORKING_ISSUES = []

def load_seed_data():
    """
    Loads initial verified defect clusters and multi-trip evidence from disk.
    Resets in-memory state during hackathon demonstration runs.
    """
    global WORKING_ISSUES
    if os.path.exists(SEED_FILE):
        with open(SEED_FILE, "r", encoding="utf-8") as f:
            WORKING_ISSUES = json.load(f)
    else:
        WORKING_ISSUES = []

load_seed_data()

def haversine_distance(lat1, lon1, lat2, lon2):
    """
    Computes the great-circle distance between two points on the Earth's surface (in meters)
    using the spherical Haversine formula.

    Mathematical Basis:
      a = sin²(Δφ/2) + cos(φ1) * cos(φ2) * sin²(Δλ/2)
      c = 2 * atan2(√a, √(1-a))
      d = R * c  (where R = 6,371,000 meters)

    Accuracy Note:
      Haversine provides sub-meter precision over typical urban corridor clustering distances
      (<500m), avoiding the computational overhead of full ellipsoidal geodesic Vincenty calculations.
    """
    R = 6371000.0  # Earth's mean radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = math.sin(delta_phi / 2.0) ** 2 + \
        math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def calculate_confidence(report_count, has_telemetry=True, peak_g=0.0):
    """
    Calculates statistical defect confidence score (0-100%) and tier (low/medium/high).
    
    Crowdsourcing Corroboration Heuristic:
      - 1 single report:   ~42% (Provisional anomaly, could be device drop or phone handling)
      - 2 independent trips: ~68% (Corroborated incident, warrants monitoring)
      - 3 independent trips: ~84% (High confidence defect cluster)
      - 4+ trips:          90-98% (Multi-vehicle confirmed infrastructure failure)
    
    Telemetry Modifier:
      Reports accompanied by strong vertical accelerometer impulses (>3.0G) receive
      an additional confidence boost (+4%), reflecting high sensor certainty.
    """
    if report_count <= 1:
        base = 42
    elif report_count == 2:
        base = 68
    elif report_count == 3:
        base = 84
    elif report_count == 4:
        base = 90
    else:
        # Diminishing returns scaling up to 98%
        base = min(98, 90 + (report_count - 4) * 2)

    # Boost score if sensor telemetry exceeds critical impact threshold
    if has_telemetry and peak_g > 3.0:
        base = min(99, base + 4)

    level = "high" if base >= 80 else ("medium" if base >= 50 else "low")
    return base, level

# -----------------
# ROUTES & REST API
# -----------------

@app.route("/")
def index():
    """Serves the single-page prototype web application (responsive desktop and mobile)."""
    return render_template("index.html")

@app.route("/api/tile-config", methods=["GET"])
def get_tile_config():
    """
    Returns supported map tile providers and attribution terms.
    Enables dynamic cartographic basemap switching in Leaflet without code edits.
    Complies with OpenStreetMap Tile Usage Policy and CARTO attribution standards.
    """
    return jsonify({
        "default": "openstreetmap",
        "providers": {
            "openstreetmap": {
                "name": "OpenStreetMap Standard (Default)",
                "url": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                "attribution": '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
                "maxZoom": 19,
                "notes": "Subject to OSM Tile Usage Policy (strictly fair-use for interactive demonstration)."
            },
            "carto_positron": {
                "name": "CartoDB Positron (High-Contrast Civic Light)",
                "url": "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
                "attribution": '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                "maxZoom": 20,
                "notes": "Clean grayscale basemap highlighting colored severity pins."
            },
            "carto_dark": {
                "name": "CartoDB Dark Matter (Night Operations)",
                "url": "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
                "attribution": '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                "maxZoom": 20,
                "notes": "Dark basemap optimized for high-contrast emergency dispatch."
            }
        }
    })

@app.route("/api/issues", methods=["GET"])
def get_issues():
    """
    Returns filtered road defect clusters.
    Supports multi-criteria querying:
      - type: pothole | harsh_braking | sharp_swerve | all
      - severity: low | medium | high | critical | all
      - confidence: low | medium | high | all
      - status: reported | under_review | scheduled | in_progress | resolved | all
      - search: substring search across title, street, neighborhood, or ID
    """
    type_filter = request.args.get("type")
    severity_filter = request.args.get("severity")
    confidence_filter = request.args.get("confidence")
    status_filter = request.args.get("status")
    search_query = request.args.get("search", "").strip().lower()

    filtered = WORKING_ISSUES

    if type_filter and type_filter != "all":
        filtered = [i for i in filtered if i.get("type") == type_filter]

    if severity_filter and severity_filter != "all":
        filtered = [i for i in filtered if i.get("severity") == severity_filter]

    if confidence_filter and confidence_filter != "all":
        filtered = [i for i in filtered if i.get("confidence_level") == confidence_filter]

    if status_filter and status_filter != "all":
        filtered = [i for i in filtered if i.get("status") == status_filter]

    if search_query:
        filtered = [
            i for i in filtered
            if search_query in i.get("title", "").lower()
            or search_query in i.get("location", {}).get("street", "").lower()
            or search_query in i.get("location", {}).get("neighborhood", "").lower()
            or search_query in i.get("id", "").lower()
        ]

    return jsonify({
        "count": len(filtered),
        "total": len(WORKING_ISSUES),
        "issues": filtered
    })

@app.route("/api/issues/<issue_id>", methods=["GET"])
def get_issue_detail(issue_id):
    """
    Returns comprehensive inspection telemetry, multi-trip reports,
    and municipal work order dispatch details for a specific defect cluster.
    """
    for issue in WORKING_ISSUES:
        if issue.get("id") == issue_id:
            return jsonify(issue)
    return jsonify({"error": "Issue not found"}), 404

@app.route("/api/issues", methods=["POST"])
def submit_issue():
    """
    Ingests a newly detected or manually submitted road hazard.
    
    Spatial Deduplication & Aggregation Logic:
      1. Parses coordinate (lat, lng) and hazard category.
      2. Scans existing issues within a 120-meter cluster threshold window.
         - 120m accounts for urban street canyon GPS multi-path drift and lane width.
      3. If a match is found:
         - Appends trip report to existing cluster
         - Increments corroboration count
         - Recomputes statistical confidence score
         - Elevates defect severity if new report indicates higher damage risk
      4. If no nearby match exists:
         - Instantiates a new provisional defect cluster with 1 initial report.
    """
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "Missing payload"}), 400

    hazard_type = data.get("type", "pothole")
    lat = float(data.get("lat", 12.9716))
    lng = float(data.get("lng", 77.5946))
    street = data.get("street", "Reported Urban Corridor")
    neighborhood = data.get("neighborhood", "Downtown Sector")
    severity = data.get("severity", "medium")
    source = data.get("source", "manual_driver")
    comment = data.get("comment", "")
    peak_g = float(data.get("peak_g", 2.5 if hazard_type == "pothole" else 0.75))

    now_iso = datetime.now(timezone.utc).isoformat()
    trip_id = f"TRIP-{len(WORKING_ISSUES)*10 + 101}"

    # Urban corridor spatial clustering radius in meters
    CLUSTER_THRESHOLD_METERS = 120.0
    matched_issue = None

    for issue in WORKING_ISSUES:
        loc = issue.get("location", {})
        d = haversine_distance(lat, lng, loc.get("lat", 0), loc.get("lng", 0))
        # Match if within spatial threshold and identical hazard category
        if d <= CLUSTER_THRESHOLD_METERS and issue.get("type") == hazard_type:
            matched_issue = issue
            break

    new_report_entry = {
        "report_id": f"REP-{len(WORKING_ISSUES)*30 + len(matched_issue['reports']) + 1 if matched_issue else 999}",
        "trip_id": trip_id,
        "timestamp": now_iso,
        "source": source,
        "device_type": "Driver Web UI" if source == "manual_driver" else "Simulated Accelerometer",
        "peak_g": peak_g if source != "manual_driver" else None,
        "user_comment": comment or ("Simulated threshold breach detected" if source != "manual_driver" else "Manual road hazard logged")
    }

    if matched_issue:
        # Spatial Corroboration: increment report count and elevate confidence
        matched_issue["reports"].append(new_report_entry)
        matched_issue["report_count"] = len(matched_issue["reports"])
        matched_issue["is_cluster"] = True
        matched_issue["updated_at"] = now_iso

        # Elevate severity if incoming report indicates higher hazard intensity
        severity_ranks = {"low": 1, "medium": 2, "high": 3, "critical": 4}
        if severity_ranks.get(severity, 1) > severity_ranks.get(matched_issue.get("severity"), 1):
            matched_issue["severity"] = severity

        # Recalculate confidence score with multi-trip boost
        has_telemetry = any(r.get("source") == "simulated_sensor" for r in matched_issue["reports"])
        conf_score, conf_level = calculate_confidence(matched_issue["report_count"], has_telemetry, peak_g)
        matched_issue["confidence"] = conf_score
        matched_issue["confidence_level"] = conf_level

        return jsonify({
            "message": "Corroborated existing road issue cluster",
            "is_new_cluster": False,
            "corroboration_count": matched_issue["report_count"],
            "new_confidence": conf_score,
            "issue": matched_issue
        }), 200

    else:
        # Create brand-new provisional defect cluster
        new_id = f"RS-{len(WORKING_ISSUES) + 101}"
        conf_score, conf_level = calculate_confidence(1, has_telemetry=(source == "simulated_sensor"), peak_g=peak_g)

        # Generate realistic waveform preview based on kinematic signature
        if hazard_type == "pothole":
            # Sharp vertical shockwave followed by rebound oscillation
            waveform = [0.98, 1.05, 1.85, peak_g, -0.92, 1.34, 1.01]
        elif hazard_type == "harsh_braking":
            # Rapid deceleration trough (negative longitudinal force)
            waveform = [0.0, -0.15, -0.42, -peak_g, -0.65, -0.22, 0.0]
        else: # swerve
            # Bipolar lateral acceleration excursion (evasion left then counter-steer)
            waveform = [0.0, 0.32, peak_g, -0.84, -0.35, 0.1, 0.0]

        new_issue = {
            "id": new_id,
            "title": f"{hazard_type.replace('_', ' ').title()} ({street.split(' near ')[0]})",
            "type": hazard_type,
            "location": {
                "lat": lat,
                "lng": lng,
                "street": street,
                "neighborhood": neighborhood,
                "city": "Bengaluru"
            },
            "severity": severity,
            "confidence": conf_score,
            "confidence_level": conf_level,
            "status": "reported",
            "created_at": now_iso,
            "updated_at": now_iso,
            "report_count": 1,
            "is_cluster": False,
            "telemetry": {
                "peak_g_force": peak_g,
                "speed_at_detection": 41.0,
                "anomaly_duration_ms": 360,
                "waveform_sample": waveform
            },
            "reports": [new_report_entry],
            "work_order": {
                "assigned_dept": "Public Works Triage Intake",
                "assigned_crew": "Pending Review",
                "priority": "P3 - Moderate" if severity in ["low", "medium"] else "P1 - Urgent",
                "notes": "Initial report logged via RoadSense platform."
            }
        }

        WORKING_ISSUES.insert(0, new_issue)
        return jsonify({
            "message": "Created new road issue report",
            "is_new_cluster": True,
            "corroboration_count": 1,
            "new_confidence": conf_score,
            "issue": new_issue
        }), 201

@app.route("/api/issues/<issue_id>/status", methods=["PATCH"])
def update_issue_status(issue_id):
    """
    Municipal triage lifecycle transition endpoint.
    Permits authorized inspectors to advance repair state:
      reported -> under_review -> scheduled -> in_progress -> resolved
    and assign field maintenance squads and resolution audit notes.
    """
    data = request.get_json(force=True)
    if not data:
        return jsonify({"error": "Missing payload"}), 400

    new_status = data.get("status")
    valid_statuses = ["reported", "under_review", "scheduled", "in_progress", "resolved"]

    if new_status and new_status not in valid_statuses:
        return jsonify({"error": f"Invalid status. Must be one of {valid_statuses}"}), 400

    for issue in WORKING_ISSUES:
        if issue.get("id") == issue_id:
            now_iso = datetime.now(timezone.utc).isoformat()
            if new_status:
                issue["status"] = new_status
            if "priority" in data:
                issue["work_order"]["priority"] = data["priority"]
            if "assigned_crew" in data:
                issue["work_order"]["assigned_crew"] = data["assigned_crew"]
            if "notes" in data:
                issue["work_order"]["notes"] = data["notes"]
            issue["updated_at"] = now_iso

            return jsonify({
                "message": "Status updated successfully",
                "issue": issue
            })

    return jsonify({"error": "Issue not found"}), 404

@app.route("/api/stats", methods=["GET"])
def get_stats():
    """
    Computes aggregate civic metrics for the government operations top bar:
      - total_issues: Total tracked road defects
      - critical_count: Critical and high severity defects requiring urgent action
      - clusters_count: Multi-trip corroborated clusters (>=2 independent trips)
      - in_repair_count: Work orders currently scheduled or in progress
      - resolved_count: Closed and resurfaced defects
    """
    total = len(WORKING_ISSUES)
    critical_or_high = len([i for i in WORKING_ISSUES if i.get("severity") in ["critical", "high"]])
    clusters = len([i for i in WORKING_ISSUES if i.get("report_count", 1) >= 2])
    scheduled_or_progress = len([i for i in WORKING_ISSUES if i.get("status") in ["scheduled", "in_progress"]])
    resolved = len([i for i in WORKING_ISSUES if i.get("status") == "resolved"])

    by_type = {
        "pothole": len([i for i in WORKING_ISSUES if i.get("type") == "pothole"]),
        "harsh_braking": len([i for i in WORKING_ISSUES if i.get("type") == "harsh_braking"]),
        "sharp_swerve": len([i for i in WORKING_ISSUES if i.get("type") == "sharp_swerve"])
    }

    return jsonify({
        "total_issues": total,
        "critical_count": critical_or_high,
        "clusters_count": clusters,
        "in_repair_count": scheduled_or_progress,
        "resolved_count": resolved,
        "by_type": by_type
    })

@app.route("/api/reset", methods=["POST"])
def reset_data():
    """
    Restores seed dataset to initial hackathon demonstration baseline.
    Ensures judges and reviewers can reliably re-run the demo script from scratch.
    """
    load_seed_data()
    return jsonify({
        "message": "Database reset to initial hackathon seed state",
        "count": len(WORKING_ISSUES)
    })

if __name__ == "__main__":
    # Development server binding to localhost port 5000
    app.run(host="127.0.0.1", port=5000, debug=True)
