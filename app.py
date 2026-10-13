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
import sys
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

# Enable CORS for local network mobile testing (e.g. phones connecting over Wi-Fi / hotspot)
@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
    return response

def haversine_distance(lat1, lon1, lat2, lon2):
    """
    Computes the great-circle distance between two points on the Earth's surface (in meters)
    using the spherical Haversine formula.
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

def process_hazard_payload(data):
    """
    Core ingestion & spatial clustering engine.
    Handles payloads from both `/api/issues` and `/api/report`.
    Supports mobile hardware sensor inputs (latitude, longitude, intensity, speed).
    """
    if not data:
        return {"error": "Missing payload"}, 400

    hazard_type = data.get("type", "pothole")
    
    # Lat/Lng normalization
    lat = data.get("latitude") if data.get("latitude") is not None else data.get("lat")
    lng = data.get("longitude") if data.get("longitude") is not None else data.get("lng")
    
    if lat is None or lng is None:
        lat = 12.9719
        lng = 77.5937
    else:
        try:
            lat = float(lat)
            lng = float(lng)
        except (ValueError, TypeError):
            lat = 12.9719
            lng = 77.5937

    # Intensity / G-force normalization
    intensity = data.get("intensity")
    peak_g = data.get("peak_g")
    
    if peak_g is not None:
        try:
            peak_g = float(peak_g)
        except (ValueError, TypeError):
            peak_g = 2.5
    elif intensity is not None:
        try:
            val = float(intensity)
            # If intensity is in m/s² (e.g. > 9.0), convert to G force
            peak_g = val / 9.80665 if val > 9.0 else val
        except (ValueError, TypeError):
            peak_g = 2.5
    else:
        peak_g = 2.5 if hazard_type == "pothole" else 0.85

    street = data.get("street") or f"Urban Corridor ({lat:.4f}, {lng:.4f})"
    neighborhood = data.get("neighborhood") or "Central District"
    severity = data.get("severity") or ("critical" if peak_g > 3.0 else ("high" if peak_g > 1.8 else "medium"))
    source = data.get("source", "mobile_sensor")
    comment = data.get("comment", "")
    speed = float(data.get("speed", 36.0) or 36.0)

    now_iso = data.get("timestamp") or datetime.now(timezone.utc).isoformat()
    trip_id = f"TRIP-{len(WORKING_ISSUES)*10 + 101}"

    # Urban corridor spatial clustering radius in meters (120m corridor grouping window)
    CLUSTER_THRESHOLD_METERS = 120.0
    matched_issue = None

    for issue in WORKING_ISSUES:
        loc = issue.get("location", {})
        d = haversine_distance(lat, lng, loc.get("lat", 0), loc.get("lng", 0))
        if d <= CLUSTER_THRESHOLD_METERS and issue.get("type") == hazard_type:
            matched_issue = issue
            break

    device_label = "Mobile Phone Sensor (Live)" if source == "mobile_sensor" else (
        "Driver Web UI" if source == "manual_driver" else "Simulated Accelerometer"
    )

    new_report_entry = {
        "report_id": f"REP-{len(WORKING_ISSUES)*30 + (len(matched_issue['reports']) if matched_issue else 0) + 1}",
        "trip_id": trip_id,
        "timestamp": now_iso,
        "source": source,
        "device_type": device_label,
        "peak_g": round(peak_g, 2) if source != "manual_driver" else None,
        "speed_kmh": round(speed, 1),
        "user_comment": comment or f"Hardware motion spike detected ({round(peak_g * 9.81, 1)} m/s²)"
    }

    if matched_issue:
        matched_issue["reports"].append(new_report_entry)
        matched_issue["report_count"] = len(matched_issue["reports"])
        matched_issue["is_cluster"] = True
        matched_issue["updated_at"] = now_iso

        severity_ranks = {"low": 1, "medium": 2, "high": 3, "critical": 4}
        if severity_ranks.get(severity, 1) > severity_ranks.get(matched_issue.get("severity"), 1):
            matched_issue["severity"] = severity

        has_telemetry = any(r.get("source") in ["simulated_sensor", "mobile_sensor"] for r in matched_issue["reports"])
        conf_score, conf_level = calculate_confidence(matched_issue["report_count"], has_telemetry, peak_g)
        matched_issue["confidence"] = conf_score
        matched_issue["confidence_level"] = conf_level

        return {
            "message": "Corroborated existing road issue cluster",
            "is_new_cluster": False,
            "corroboration_count": matched_issue["report_count"],
            "new_confidence": conf_score,
            "issue": matched_issue
        }, 200

    else:
        new_id = f"RS-{len(WORKING_ISSUES) + 101}"
        conf_score, conf_level = calculate_confidence(1, has_telemetry=(source in ["simulated_sensor", "mobile_sensor"]), peak_g=peak_g)

        if hazard_type == "pothole":
            waveform = [0.98, 1.05, 1.85, round(peak_g, 2), -0.92, 1.34, 1.01]
        elif hazard_type == "harsh_braking":
            waveform = [0.0, -0.15, -0.42, round(-peak_g, 2), -0.65, -0.22, 0.0]
        else:
            waveform = [0.0, 0.32, round(peak_g, 2), -0.84, -0.35, 0.1, 0.0]

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
                "peak_g_force": round(peak_g, 2),
                "speed_at_detection": round(speed, 1),
                "anomaly_duration_ms": 360,
                "waveform_sample": waveform
            },
            "reports": [new_report_entry],
            "work_order": {
                "assigned_dept": "Public Works Triage Intake",
                "assigned_crew": "Pending Review",
                "priority": "P3 - Moderate" if severity in ["low", "medium"] else "P1 - Urgent",
                "notes": "Live motion impact report registered via RoadSense mobile platform."
            }
        }

        WORKING_ISSUES.insert(0, new_issue)
        return {
            "message": "Created new road issue report",
            "is_new_cluster": True,
            "corroboration_count": 1,
            "new_confidence": conf_score,
            "issue": new_issue
        }, 201

@app.route("/api/issues", methods=["POST", "OPTIONS"])
def submit_issue():
    """Manual or simulated hazard submission endpoint."""
    if request.method == "OPTIONS":
        return jsonify({}), 200
    data = request.get_json(force=True, silent=True)
    res_data, status_code = process_hazard_payload(data)
    return jsonify(res_data), status_code

@app.route("/api/report", methods=["POST", "OPTIONS"])
def report_pothole():
    """
    Direct mobile sensor impact ingestion endpoint.
    Expects { latitude, longitude, intensity, speed, timestamp, ... }
    Automatically dedupes, updates confidence, and returns updated cluster.
    """
    if request.method == "OPTIONS":
        return jsonify({}), 200
    data = request.get_json(force=True, silent=True)
    res_data, status_code = process_hazard_payload(data)
    return jsonify(res_data), status_code

@app.route("/api/issues/<issue_id>/status", methods=["PATCH", "OPTIONS"])
def update_issue_status(issue_id):
    """
    Municipal triage lifecycle transition endpoint.
    Permits authorized inspectors to advance repair state:
      reported -> under_review -> scheduled -> in_progress -> resolved
    """
    if request.method == "OPTIONS":
        return jsonify({}), 200

    data = request.get_json(force=True, silent=True)
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
    Computes aggregate civic metrics for the dashboard header.
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

@app.route("/api/reset", methods=["POST", "OPTIONS"])
def reset_data():
    """
    Restores seed dataset to initial hackathon demonstration baseline.
    """
    if request.method == "OPTIONS":
        return jsonify({}), 200
    load_seed_data()
    return jsonify({
        "message": "Database reset to initial hackathon seed state",
        "count": len(WORKING_ISSUES)
    })

if __name__ == "__main__":
    host = "0.0.0.0"
    port = 5000
    ssl_context = None
    if "--ssl" in sys.argv:
        ssl_context = "adhoc"
        print("Starting RoadSense with HTTPS adhoc SSL context...")

    print(f"RoadSense Server running on http://{host}:{port} (and http://127.0.0.1:{port})")
    app.run(host=host, port=port, debug=True, ssl_context=ssl_context)
