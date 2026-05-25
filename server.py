#!/usr/bin/env python3
"""
AeroStride: Premium AI Marathon Coaching Server
Integrates SQLite, Flask 3.0, Strava OAuth 2.0, and direct Garmin Connect sync.
"""

import os
import time
import sqlite3
import urllib.parse
import json
import requests
from flask import Flask, request, redirect, jsonify, send_from_directory
try:
    from garminconnect import Garmin as GarminClient
    GARMIN_AVAILABLE = True
except ImportError:
    GARMIN_AVAILABLE = False
    print("WARNING: garminconnect not installed. Run: pip install garminconnect")

app = Flask(__name__, static_folder='.')
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.db')

# ----------------------------------------------------
# DATABASE SETUP & UTILITIES
# ----------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 1. Config store (Client ID / Client Secret)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                val TEXT
            )
        ''')
        
        # 2. OAuth tokens store
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS tokens (
                service TEXT PRIMARY KEY,
                access_token TEXT,
                refresh_token TEXT,
                expires_at INTEGER
            )
        ''')
        
        # 3. Activities store
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS activities (
                id TEXT PRIMARY KEY,
                name TEXT,
                type TEXT,
                distance REAL,
                duration INTEGER,
                avg_heart_rate INTEGER,
                date TEXT,
                provider TEXT,
                week INTEGER,
                day INTEGER,
                completed INTEGER
            )
        ''')
        
        # 4. Completed Workouts map (keys: 'week-day')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS completed_workouts (
                key TEXT PRIMARY KEY
            )
        ''')

        # 5. User Profile parameters (marathonDate, targetTime, experience, weeklyMiles, plan JSON)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_profile (
                key TEXT PRIMARY KEY,
                val TEXT
            )
        ''')

        # 6. Garmin session cache to avoid frequent re-logins
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS garmin_session (
                id INTEGER PRIMARY KEY,
                session_data TEXT,
                saved_at INTEGER
            )
        ''')
        
        conn.commit()

init_db()

# ----------------------------------------------------
# FRONTEND STATIC ASSETS SERVERS
# ----------------------------------------------------
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/style.css')
def serve_css():
    return send_from_directory('.', 'style.css')

@app.route('/app.js')
def serve_js():
    return send_from_directory('.', 'app.js')

# ----------------------------------------------------
# PROFILE & CONFIG APIs
# ----------------------------------------------------
@app.route('/api/profile', methods=['GET'])
def get_profile():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT key, val FROM user_profile")
        rows = cursor.fetchall()
        
        profile = {}
        for row in rows:
            if row['key'] == 'trainingPlan':
                try:
                    profile[row['key']] = json.loads(row['val'])
                except:
                    profile[row['key']] = None
            else:
                profile[row['key']] = row['val']
                
        return jsonify(profile)

@app.route('/api/profile/save', methods=['POST'])
def save_profile():
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
        
    with get_db() as conn:
        cursor = conn.cursor()
        for k, v in data.items():
            if k == 'trainingPlan':
                val_str = json.dumps(v)
            else:
                val_str = str(v)
            cursor.execute("INSERT OR REPLACE INTO user_profile (key, val) VALUES (?, ?)", (k, val_str))
        conn.commit()
        
    return jsonify({"status": "success"})

@app.route('/api/config', methods=['GET'])
def get_config():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM config WHERE key = 'strava_client_id'")
        row_id = cursor.fetchone()
        
        cursor.execute("SELECT val FROM config WHERE key = 'strava_client_secret'")
        row_sec = cursor.fetchone()
        
        cursor.execute("SELECT service FROM tokens WHERE service = 'strava'")
        row_tok = cursor.fetchone()

        # Garmin connection state
        cursor.execute("SELECT val FROM config WHERE key = 'garmin_email'")
        garmin_email_row = cursor.fetchone()
        cursor.execute("SELECT val FROM config WHERE key = 'garmin_password'")
        garmin_pass_row = cursor.fetchone()
        cursor.execute("SELECT val FROM config WHERE key = 'garmin_connected'")
        garmin_connected_row = cursor.fetchone()
        
        configured = bool(row_id and row_id['val'] and row_sec and row_sec['val'])
        connected = bool(row_tok)
        garmin_configured = bool(garmin_email_row and garmin_email_row['val'] and garmin_pass_row and garmin_pass_row['val'])
        garmin_connected = bool(garmin_connected_row and garmin_connected_row['val'] == 'true')
        
        return jsonify({
            "strava_configured": configured,
            "strava_connected": connected,
            "strava_client_id": row_id['val'] if row_id else "",
            "garmin_configured": garmin_configured,
            "garmin_connected": garmin_connected,
            "garmin_email": garmin_email_row['val'] if garmin_email_row else "",
            "garmin_available": GARMIN_AVAILABLE
        })

@app.route('/api/config/save', methods=['POST'])
def save_config():
    data = request.json
    client_id = data.get('client_id', '').strip()
    client_secret = data.get('client_secret', '').strip()
    
    if not client_id or not client_secret:
        return jsonify({"error": "Both Client ID and Client Secret are required"}), 400
        
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('strava_client_id', ?)", (client_id,))
        cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('strava_client_secret', ?)", (client_secret,))
        conn.commit()
        
    return jsonify({"status": "success"})

# ----------------------------------------------------
# GARMIN CONNECT DIRECT SYNC ENDPOINTS
# ----------------------------------------------------
# ----------------------------------------------------
# GARMIN CONNECT DIRECT SYNC ENDPOINTS (PROGRAMMATIC MFA)
# ----------------------------------------------------
import queue
import threading

garmin_sessions = {}  # email -> { "status": "connecting", "queue": queue.Queue(), "synced_count": 0, "error": None }

@app.route('/api/config/garmin/save', methods=['POST'])
def save_garmin_config():
    data = request.json
    email = data.get('email', '').strip()
    password = data.get('password', '').strip()
    
    if not email or not password:
        return jsonify({"error": "Both email and password are required"}), 400
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('garmin_email', ?)", (email,))
        cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('garmin_password', ?)", (password,))
        cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('garmin_connected', 'false')")
        # Clear old session cache so new credentials are used
        cursor.execute("DELETE FROM garmin_session")
        conn.commit()
        
    # Clear active session tracker state
    if email in garmin_sessions:
        garmin_sessions.pop(email)
    
    return jsonify({"status": "success"})


@app.route('/api/sync/garmin/status')
def sync_garmin_status():
    email = request.args.get('email', '').strip()
    if not email:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT val FROM config WHERE key = 'garmin_email'")
            email_row = cursor.fetchone()
        email = email_row['val'] if email_row else ""

    if not email:
        return jsonify({"status": "idle", "error": "No email configured"})

    session = garmin_sessions.get(email)
    if not session:
        return jsonify({"status": "idle"})

    return jsonify({
        "status": session["status"],
        "synced_activities_count": session.get("synced_count", 0),
        "error": session["error"]
    })


@app.route('/api/sync/garmin/mfa', methods=['POST'])
def sync_garmin_mfa():
    data = request.json or {}
    email = data.get('email', '').strip()
    otp = data.get('otp', '').strip()

    if not email:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT val FROM config WHERE key = 'garmin_email'")
            email_row = cursor.fetchone()
        email = email_row['val'] if email_row else ""

    if not email or not otp:
        return jsonify({"error": "Email and OTP are required"}), 400

    session = garmin_sessions.get(email)
    if not session or session["status"] != "mfa_required":
        return jsonify({"error": "No active MFA session found for this user"}), 400

    # Put the OTP into the queue to unblock the thread
    session["queue"].put(otp)
    session["status"] = "connecting"  # transition back to connecting
    return jsonify({"status": "received"})


@app.route('/api/sync/garmin')
def sync_garmin():
    if not GARMIN_AVAILABLE:
        return jsonify({"error": "garminconnect library not installed. Run: pip install garminconnect"}), 500

    # Fetch stored credentials
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM config WHERE key = 'garmin_email'")
        email_row = cursor.fetchone()
        cursor.execute("SELECT val FROM config WHERE key = 'garmin_password'")
        pass_row = cursor.fetchone()

    if not email_row or not pass_row:
        return jsonify({"error": "Garmin credentials not configured"}), 401

    email = email_row['val']
    password = pass_row['val']

    # Get marathon date for training week mapping
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM user_profile WHERE key = 'marathonDate'")
        m_row = cursor.fetchone()

    marathon_date_str = m_row['val'] if m_row else ""
    if not marathon_date_str:
        return jsonify({"error": "Marathon target date must be set before sync"}), 400

    m_time = time.strptime(marathon_date_str, "%Y-%m-%d")
    m_epoch = time.mktime(m_time)

    # Check if session already exists
    session = garmin_sessions.get(email)
    if session and session["status"] in ["connecting", "mfa_required"]:
        return jsonify({"status": session["status"], "message": "Sync already in progress"})

    # Initialize a new session
    garmin_sessions[email] = {
        "status": "connecting",
        "queue": queue.Queue(),
        "synced_count": 0,
        "error": None
    }

    def run_sync():
        cur_session = garmin_sessions[email]
        
        def prompt_mfa_callback():
            cur_session["status"] = "mfa_required"
            # Block and wait for OTP from the REST endpoint
            try:
                # Wait up to 180 seconds for OTP code
                code = cur_session["queue"].get(timeout=180)
                return code
            except queue.Empty:
                raise Exception("MFA Verification Timed Out. Please retry sync.")

        try:
            # Authenticate with Garmin Connect
            client = GarminClient(email, password, prompt_mfa=prompt_mfa_callback)
            client.login()

            # Fetch all 2026 activities (Jan 1 → today)
            today_str = time.strftime("%Y-%m-%d")
            activities = client.get_activities_by_date("2026-01-01", today_str)

            print(f"[Garmin Sync Thread] Fetched {len(activities)} total activities from 2026")

            # Activity type normalizer
            GARMIN_TYPE_MAP = {
                'running': 'Run',
                'trail_running': 'Run',
                'treadmill_running': 'Run',
                'cycling': 'Ride',
                'road_biking': 'Ride',
                'mountain_biking': 'Ride',
                'indoor_cycling': 'Ride',
                'virtual_ride': 'Ride',
                'swimming': 'Swim',
                'open_water_swimming': 'Swim',
                'lap_swimming': 'Swim',
                'walking': 'Walk',
                'hiking': 'Walk',
                'fitness_equipment': 'Strength',
                'strength_training': 'Strength',
                'indoor_rowing': 'Strength',
                'yoga': 'Strength',
                'elliptical': 'Strength',
                'cardio': 'Strength',
            }

            synced_count = 0
            with get_db() as conn:
                cursor = conn.cursor()

                for act in activities:
                    # Pull core fields from Garmin activity dict
                    act_id_raw = act.get('activityId') or act.get('activityid') or str(time.time())
                    act_id = f"garmin-{act_id_raw}"

                    name = act.get('activityName') or act.get('activityname') or 'Garmin Activity'

                    # Determine sport type
                    garmin_type_raw = (
                        act.get('activityType', {}).get('typeKey', '') or
                        act.get('activityTypePK', '') or ''
                    ).lower()
                    sport = GARMIN_TYPE_MAP.get(garmin_type_raw, 'Other')

                    # Distance — Garmin returns meters
                    dist_m = act.get('distance') or 0
                    distance_miles = float(dist_m) * 0.000621371

                    # Duration — Garmin returns seconds
                    dur_s = act.get('duration') or act.get('movingDuration') or 0
                    duration_min = round(float(dur_s) / 60)

                    # Average heart rate
                    avg_hr = round(act.get('averageHR') or act.get('avgHr') or 0)

                    # Date
                    date_raw = act.get('startTimeLocal') or act.get('startTimeGMT') or ''
                    date_str = date_raw[:10] if date_raw else today_str

                    # Calculate training week relative to marathon
                    try:
                        act_t = time.strptime(date_str, "%Y-%m-%d")
                        act_epoch = time.mktime(act_t)
                        days_before = int((m_epoch - act_epoch) / (24 * 3600))
                        if days_before < 0:
                            week = 16
                        else:
                            week = 16 - int(days_before / 7)
                            if week < 1:
                                week = 0  # Map historical/pre-training runs to Week 0 instead of compressing into Week 1
                        w_day = act_t.tm_wday  # 0=Mon, 6=Sun
                    except Exception:
                        week = 0
                        w_day = 0

                    # Write to database
                    cursor.execute('''
                        INSERT OR REPLACE INTO activities
                        (id, name, type, distance, duration, avg_heart_rate, date, provider, week, day, completed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'garmin', ?, ?, 1)
                    ''', (act_id, name, sport, distance_miles, duration_min, avg_hr, date_str, week, w_day))

                    # Only check off running workouts against the active 16-week training plan
                    if sport == 'Run' and week >= 1:
                        cursor.execute(
                            "INSERT OR REPLACE INTO completed_workouts (key) VALUES (?)",
                            (f"{week}-{w_day}",)
                        )

                    synced_count += 1

                # Mark Garmin as connected
                cursor.execute("INSERT OR REPLACE INTO config (key, val) VALUES ('garmin_connected', 'true')")
                conn.commit()

            cur_session["synced_count"] = synced_count
            cur_session["status"] = "success"
            print(f"[Garmin Sync Thread] Saved {synced_count} activities to database successfully.")

        except Exception as e:
            error_msg = str(e)
            print(f"[Garmin Sync Thread] Error: {error_msg}")
            cur_session["status"] = "failed"
            # Common auth errors
            if 'NEEDS_MFA' in error_msg or 'MFA' in error_msg.upper() or 'OTP' in error_msg.upper() or 'code' in error_msg.lower():
                cur_session["error"] = "Garmin MFA Verification failed. Please ensure the code is correct."
            elif '401' in error_msg or 'Unauthorized' in error_msg or 'credentials' in error_msg.lower() or 'password' in error_msg.lower():
                cur_session["error"] = "Invalid Garmin credentials. Please verify your email and password."
            else:
                cur_session["error"] = f"Garmin sync failed: {error_msg}"

    # Spawn background thread
    threading.Thread(target=run_sync).start()
    return jsonify({"status": "connecting", "message": "Sync started on background thread"})


# ----------------------------------------------------
# REAL-TIME STRAVA OAUTH 2.0 FLOWS
# ----------------------------------------------------
@app.route('/api/connect/strava')
def connect_strava():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM config WHERE key = 'strava_client_id'")
        row = cursor.fetchone()
        
    if not row or not row['val']:
        return "Error: Strava Client ID not configured. Please enter credentials in the AeroStride dashboard first.", 400
        
    client_id = row['val']
    
    # Generate redirect authorization link
    redirect_uri = "http://localhost:8000/strava/callback"
    scope = "activity:read_all"
    
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": scope
    }
    strava_auth_url = "https://www.strava.com/oauth/authorize?" + urllib.parse.urlencode(params)
    return redirect(strava_auth_url)

@app.route('/strava/callback')
def strava_callback():
    code = request.args.get('code')
    error = request.args.get('error')
    
    if error or not code:
        return redirect('/?status=strava-error')
        
    # Fetch Client ID and Secret
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM config WHERE key = 'strava_client_id'")
        client_id_row = cursor.fetchone()
        cursor.execute("SELECT val FROM config WHERE key = 'strava_client_secret'")
        client_secret_row = cursor.fetchone()
        
    if not client_id_row or not client_secret_row:
        return "Error: Database credentials missing during callback.", 500
        
    # Exchange code for tokens
    payload = {
        'client_id': client_id_row['val'],
        'client_secret': client_secret_row['val'],
        'code': code,
        'grant_type': 'authorization_code'
    }
    
    try:
        res = requests.post("https://www.strava.com/api/v3/oauth/token", data=payload)
        res_data = res.json()
        
        access_token = res_data.get('access_token')
        refresh_token = res_data.get('refresh_token')
        expires_at = res_data.get('expires_at')
        
        if not access_token:
            return f"Error: Token exchange failed. Payload response: {res_data}", 400
            
        # Store securely
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO tokens (service, access_token, refresh_token, expires_at) VALUES ('strava', ?, ?, ?)",
                (access_token, refresh_token, expires_at)
            )
            conn.commit()
            
        return redirect('/?status=strava-connected')
    except Exception as e:
        return f"OAuth Server Connection Error: {str(e)}", 500

# ----------------------------------------------------
# TOKEN REFRESH & STRAVA DATA SYNC PIPELINE
# ----------------------------------------------------
def get_valid_strava_token():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT access_token, refresh_token, expires_at FROM tokens WHERE service = 'strava'")
        row = cursor.fetchone()
        
    if not row:
        return None
        
    access_token = row['access_token']
    refresh_token = row['refresh_token']
    expires_at = row['expires_at']
    
    # Check if expired (or within 5 minutes of expiration buffer)
    current_epoch = int(time.time())
    if expires_at - current_epoch < 300:
        # Token is expired! Make POST exchange to refresh
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT val FROM config WHERE key = 'strava_client_id'")
            id_row = cursor.fetchone()
            cursor.execute("SELECT val FROM config WHERE key = 'strava_client_secret'")
            sec_row = cursor.fetchone()
            
        if not id_row or not sec_row:
            return None
            
        payload = {
            'client_id': id_row['val'],
            'client_secret': sec_row['val'],
            'grant_type': 'refresh_token',
            'refresh_token': refresh_token
        }
        
        try:
            res = requests.post("https://www.strava.com/api/v3/oauth/token", data=payload)
            res_data = res.json()
            
            new_access = res_data.get('access_token')
            new_refresh = res_data.get('refresh_token', refresh_token)
            new_expires = res_data.get('expires_at')
            
            if new_access:
                with get_db() as conn:
                    cursor = conn.cursor()
                    cursor.execute(
                        "INSERT OR REPLACE INTO tokens (service, access_token, refresh_token, expires_at) VALUES ('strava', ?, ?, ?)",
                        (new_access, new_refresh, new_expires)
                    )
                    conn.commit()
                return new_access
        except Exception as e:
            print("Token refresh request failed", e)
            
    return access_token

@app.route('/api/sync/strava')
def sync_strava():
    token = get_valid_strava_token()
    if not token:
        return jsonify({"error": "Strava not connected"}), 401
        
    # Get user marathon date to calculate training week map relative to race day
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT val FROM user_profile WHERE key = 'marathonDate'")
        m_row = cursor.fetchone()
    
    marathon_date_str = m_row['val'] if m_row else ""
    if not marathon_date_str:
        return jsonify({"error": "Marathon target date must be set before sync"}), 400
        
    m_time = time.strptime(marathon_date_str, "%Y-%m-%d")
    m_epoch = time.mktime(m_time)
    
    headers = {"Authorization": f"Bearer {token}"}
    
    # We fetch activities since 18 weeks before marathon date (to cover the 16 week training block + buffer)
    start_epoch = int(m_epoch - (18 * 7 * 24 * 3600))
    
    try:
        res = requests.get(
            "https://www.strava.com/api/v3/athlete/activities",
            headers=headers,
            params={"after": start_epoch, "per_page": 60}
        )
        
        if res.status_code != 200:
            return jsonify({"error": f"Failed fetching activities: {res.text}"}), res.status_code
            
        activities = res.json()
        synced_count = 0
        
        with get_db() as conn:
            cursor = conn.cursor()
            
            for act in activities:
                # Filter for run activities
                if act.get('type') != 'Run':
                    continue
                    
                act_id = f"strava-{act['id']}"
                name = act.get('name', 'Strava Sync Run')
                distance_meters = act.get('distance', 0)
                distance_miles = distance_meters * 0.000621371 # convert to miles
                
                # Duration in minutes
                duration_sec = act.get('moving_time', 0)
                duration_min = round(duration_sec / 60)
                
                avg_hr = round(act.get('average_heartrate', 0))
                date_str = act.get('start_date_local', '').split('T')[0]
                
                # Calculate training week (w) relative to marathon date
                act_time = time.strptime(date_str, "%Y-%m-%d")
                act_epoch = time.mktime(act_time)
                
                days_before = int((m_epoch - act_epoch) / (24 * 3600))
                if days_before < 0:
                    # After race day
                    week = 16
                else:
                    # 16-week mapping (days 0-6 before is Week 16, days 7-13 is Week 15 ...)
                    week = 16 - int(days_before / 7)
                    if week < 1:
                        week = 0 # Map historical/pre-training runs to Week 0 instead of compressing into Week 1
                        
                # Determine day index based on weekday (Monday-first)
                w_day = act_time.tm_wday # 0 = Monday ... 6 = Sunday
                
                # Write to database
                cursor.execute('''
                    INSERT OR REPLACE INTO activities 
                    (id, name, type, distance, duration, avg_heart_rate, date, provider, week, day, completed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'strava', ?, ?, 1)
                ''', (act_id, name, 'Aerobic Base Run', distance_miles, duration_min, avg_hr, date_str, week, w_day))
                
                # Mark as checked in training plan checkoff list (only if it is part of the active 16 weeks)
                if week >= 1:
                    cursor.execute("INSERT OR REPLACE INTO completed_workouts (key) VALUES (?)", (f"{week}-{w_day}",))
                synced_count += 1
                
            conn.commit()
            
        return jsonify({"status": "success", "synced_activities_count": synced_count})
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ----------------------------------------------------
# MANUAL ACTIVITIES & MANUAL SYNC ENDPOINTS
# ----------------------------------------------------
@app.route('/api/activities', methods=['GET'])
def get_activities():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM activities")
        rows = cursor.fetchall()
        
        acts = []
        for r in rows:
            acts.append({
                "id": r['id'],
                "name": r['name'],
                "type": r['type'],
                "distance": r['distance'],
                "duration": r['duration'],
                "avgHeartRate": r['avg_heart_rate'],
                "date": r['date'],
                "provider": r['provider'],
                "week": r['week'],
                "day": r['day'],
                "completed": bool(r['completed'])
            })
        return jsonify(acts)

@app.route('/api/activities/add', methods=['POST'])
def add_activity():
    act = request.json
    if not act:
        return jsonify({"error": "No activity data provided"}), 400
        
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT OR REPLACE INTO activities 
            (id, name, type, distance, duration, avg_heart_rate, date, provider, week, day, completed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ''', (
            act['id'], act['name'], act['type'], act['distance'],
            act['duration'], act['avgHeartRate'], act['date'],
            act['provider'], act['week'], act['day']
        ))
        
        # Auto check off in plans as well
        cursor.execute("INSERT OR REPLACE INTO completed_workouts (key) VALUES (?)", (f"{act['week']}-{act['day']}",))
        conn.commit()
        
    return jsonify({"status": "success"})

@app.route('/api/completed-workouts', methods=['GET', 'POST'])
def handle_completed_workouts():
    if request.method == 'GET':
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT key FROM completed_workouts")
            rows = cursor.fetchall()
            completed = {}
            for r in rows:
                completed[r['key']] = True
            return jsonify(completed)
    else:
        # POST: overwrite the entire completed list
        completed_keys = request.json # expected to be list of keys: ['1-0', '2-3']
        if completed_keys is None:
            return jsonify({"error": "Invalid payload"}), 400
            
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM completed_workouts")
            for k in completed_keys:
                cursor.execute("INSERT INTO completed_workouts (key) VALUES (?)", (k,))
            conn.commit()
        return jsonify({"status": "success"})

# ----------------------------------------------------
# MAIN PROCESS EXECUTION
# ----------------------------------------------------
if __name__ == '__main__':
    print("--------------------------------------------------")
    print(" AeroStride AI Marathon Coach Real-Time Server     ")
    print(" Local address: http://localhost:8000             ")
    print("--------------------------------------------------")
    app.run(host='0.0.0.0', port=8000, debug=True)
