/* AeroStride core client-side logic and AI engine - Backend Integration Version */

// App State Model
let appState = {
  marathonDate: "",
  targetTime: "3:30:00",
  experience: "intermediate",
  weeklyMiles: 30,
  trainingPlan: null,
  completedWorkouts: {}, // keys: 'weekNum-dayIndex' e.g. '1-2'
  connectedServices: {
    garmin: false,
    strava: false
  },
  activities: [],
  bioIndicators: {
    sleep: false,
    soreness: false
  },
  activeWeek: 1,
  apiConfig: {
    strava_configured: false,
    strava_connected: false,
    strava_client_id: "",
    garmin_configured: false,
    garmin_connected: false,
    garmin_email: "",
    garmin_available: true
  }
};

// No default mock activities - strictly user data sync
const defaultMockActivities = [];

// Initialize application on load
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // 1. Fetch data from SQLite backend or fallback to LocalStorage
  await loadStateFromServer();

  // Handle OAuth redirection query parameters for feedback alerts
  const urlParams = new URLSearchParams(window.location.search);
  const status = urlParams.get('status');
  
  if (status === 'strava-connected') {
    showToast("Strava authorization successful! Initiating real-time running sync...", "success");
    // Clean URL
    window.history.replaceState({}, document.title, "/");
    triggerRealtimeStravaSync();
  } else if (status === 'strava-error') {
    showToast("Strava connection failed. Verify Client Secret is correct.", "warning");
    window.history.replaceState({}, document.title, "/");
  }

  // Set default marathon date if not set (14 weeks from today)
  if (!appState.marathonDate) {
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 98); // 98 days = 14 weeks
    appState.marathonDate = defaultDate.toISOString().split('T')[0];
  }

  // Generate a mock initial plan if none exists, so they see a premium state immediately
  if (!appState.trainingPlan) {
    appState.trainingPlan = generatePlanArray("intermediate", 30, "3:30:00");
    // Clear completed workouts initially
    appState.completedWorkouts = {};
    saveStateToServer();
  }

  // Pre-fill plan form inputs with active state
  document.getElementById('form-marathon-date').value = appState.marathonDate;
  document.getElementById('form-target-time').value = appState.targetTime;
  document.getElementById('form-weekly-miles').value = appState.weeklyMiles;
  document.getElementById('form-experience').value = appState.experience;

  updateDashboardUI();
  renderWeeklyPlanCalendar();
  renderActivitiesList();
  
  showToast("Welcome to AeroStride. Your AI running model is loaded.", "info");
}

// ----------------------------------------------------
// STATE PERSISTENCE (SERVER + LOCAL FALLBACK)
// ----------------------------------------------------
async function saveStateToServer() {
  try {
    // Save Profile & Plan parameters
    await fetch('/api/profile/save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        marathonDate: appState.marathonDate,
        targetTime: appState.targetTime,
        experience: appState.experience,
        weeklyMiles: appState.weeklyMiles,
        trainingPlan: appState.trainingPlan,
        bioIndicators: JSON.stringify(appState.bioIndicators)
      })
    });

    // Save completed checklist keys
    const completedKeys = Object.keys(appState.completedWorkouts);
    await fetch('/api/completed-workouts', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(completedKeys)
    });

  } catch (e) {
    console.warn("Unable to save state to server, falling back to LocalStorage", e);
    localStorage.setItem('aerostride_state', JSON.stringify(appState));
  }
}

async function loadStateFromServer() {
  try {
    // 1. Fetch Profile params
    const profRes = await fetch('/api/profile');
    if (profRes.ok) {
      const prof = await profRes.json();
      if (prof.marathonDate) {
        appState.marathonDate = prof.marathonDate;
        appState.targetTime = prof.targetTime;
        appState.experience = prof.experience;
        appState.weeklyMiles = parseInt(prof.weeklyMiles) || 30;
        appState.trainingPlan = prof.trainingPlan;
        if (prof.bioIndicators) {
          appState.bioIndicators = JSON.parse(prof.bioIndicators);
        }
      }
    }

    // 2. Fetch completed checklist keys
    const checkRes = await fetch('/api/completed-workouts');
    if (checkRes.ok) {
      const keysMap = await checkRes.json();
      appState.completedWorkouts = keysMap || {};
    }

    // 3. Fetch running activities from database
    const actRes = await fetch('/api/activities');
    if (actRes.ok) {
      const acts = await actRes.json();
      appState.activities = acts || [];
    }

    // 4. Fetch Server configurations states (Strava + Garmin)
    const confRes = await fetch('/api/config');
    if (confRes.ok) {
      const config = await confRes.json();
      appState.apiConfig = config;
      appState.connectedServices.strava = config.strava_connected;
      appState.connectedServices.garmin = config.garmin_connected;
    }

    // strictly use user sync data

  } catch (e) {
    console.warn("Server backend offline. Running in Local Storage Fallback Mode.", e);
    // Load local storage fallback
    const saved = localStorage.getItem('aerostride_state');
    if (saved) {
      try {
        appState = JSON.parse(saved);
      } catch (err) {}
    }
    if (!appState.activities || appState.activities.length === 0) {
      appState.activities = [...defaultMockActivities];
    }
  }
}

// ----------------------------------------------------
// TAB SYSTEM NAVIGATION
// ----------------------------------------------------
function switchTab(tabId) {
  document.getElementById('view-dashboard-container').style.display = 'none';
  document.getElementById('view-plan-container').style.display = 'none';
  document.getElementById('view-activities-container').style.display = 'none';
  document.getElementById('view-coach-container').style.display = 'none';
  
  document.getElementById('nav-dashboard').classList.remove('active');
  document.getElementById('nav-plan').classList.remove('active');
  document.getElementById('nav-activities').classList.remove('active');
  document.getElementById('nav-coach').classList.remove('active');
  
  if (tabId === 'dashboard') {
    document.getElementById('view-dashboard-container').style.display = 'block';
    document.getElementById('nav-dashboard').classList.add('active');
    renderVolumeChart();
  } else if (tabId === 'plan') {
    document.getElementById('view-plan-container').style.display = 'block';
    document.getElementById('nav-plan').classList.add('active');
    renderWeeklyPlanCalendar();
  } else if (tabId === 'activities') {
    // Transition to the main dashboard container and smoothly scroll to the Training Log feed
    switchTab('dashboard');
    setTimeout(() => {
      const el = document.getElementById('activity-list-container');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Visual highlight flash
        const cardParent = el.closest('.card');
        if (cardParent) {
          cardParent.style.borderColor = 'rgba(99, 102, 241, 0.4)';
          cardParent.style.boxShadow = '0 0 25px rgba(99, 102, 241, 0.25)';
          setTimeout(() => {
            cardParent.style.borderColor = '';
            cardParent.style.boxShadow = '';
          }, 1500);
        }
      }
    }, 150);
  } else if (tabId === 'coach') {
    document.getElementById('view-coach-container').style.display = 'block';
    document.getElementById('nav-coach').classList.add('active');
    renderAthleteIntelligenceTrends();
  }
}

// ----------------------------------------------------
// MAIN DASHBOARD RENDERING
// ----------------------------------------------------
function updateDashboardUI() {
  const hr = new Date().getHours();
  let greet = "Good morning, Runner";
  if (hr >= 12 && hr < 17) greet = "Good afternoon, Runner";
  else if (hr >= 17) greet = "Good evening, Runner";
  document.getElementById('user-greeting').textContent = greet;

  const mDate = new Date(appState.marathonDate);
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  document.getElementById('metric-target-date').textContent = "Target: " + mDate.toLocaleDateString('en-US', options);
  
  const today = new Date();
  const timeDiff = mDate.getTime() - today.getTime();
  const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
  
  if (daysDiff >= 0) {
    document.getElementById('metric-countdown').innerHTML = `${daysDiff} <span class="metric-unit">days</span>`;
    document.getElementById('gauge-days-val').textContent = daysDiff;
    document.getElementById('gauge-days-label').textContent = "Days Left";
    
    const weeksRemaining = Math.max(0, Math.min(16, Math.ceil(daysDiff / 7)));
    const weeksDone = 16 - weeksRemaining;
    document.getElementById('gauge-weeks-num').textContent = `${weeksDone} / 16`;
    
    const strokeDashoffset = 440 - (440 * (weeksDone / 16));
    document.getElementById('countdown-progress-ring').style.strokeDashoffset = strokeDashoffset;
  } else {
    document.getElementById('metric-countdown').innerHTML = `Race Day!`;
    document.getElementById('gauge-days-val').textContent = "0";
    document.getElementById('gauge-days-label').textContent = "Race Over";
    document.getElementById('countdown-progress-ring').style.strokeDashoffset = 0;
    document.getElementById('gauge-weeks-num').textContent = `16 / 16`;
  }

  let currentTrainingWeek = 1;
  if (daysDiff > 0) {
    currentTrainingWeek = Math.max(1, Math.min(16, 17 - Math.ceil(daysDiff / 7)));
  }
  appState.activeWeek = currentTrainingWeek;

  const actualWeekMiles = calculateWeekActualMiles(currentTrainingWeek);
  document.getElementById('metric-weekly-vol').innerHTML = `${actualWeekMiles.toFixed(1)} <span class="metric-unit">mi</span>`;
  
  if (appState.trainingPlan && appState.trainingPlan[currentTrainingWeek - 1]) {
    const plannedVol = appState.trainingPlan[currentTrainingWeek - 1].plannedVolume;
    document.getElementById('metric-vol-trend').textContent = `Week ${currentTrainingWeek} Plan: ${plannedVol} mi`;
  } else {
    document.getElementById('metric-vol-trend').textContent = `No periodized targets`;
  }

  const planRunsCount = countPlanTotalRuns();
  const completedRunsCount = Object.keys(appState.completedWorkouts).length;
  const consistencyPct = planRunsCount > 0 ? Math.round((completedRunsCount / planRunsCount) * 100) : 0;
  document.getElementById('metric-consistency').innerHTML = `${consistencyPct} <span class="metric-unit">%</span>`;
  document.getElementById('metric-runs-completed').textContent = `${completedRunsCount} of ${planRunsCount} workouts done`;

  const paceStats = calculateAveragePace();
  document.getElementById('metric-avg-pace').innerHTML = `${paceStats.paceStr} <span class="metric-unit">/mi</span>`;
  
  const racePaceStr = calculateTargetPaceStr();
  document.getElementById('metric-pace-target').textContent = `Marathon Pace Target: ${racePaceStr}/mi`;

  const totalMilesAllTime = appState.activities.reduce((acc, curr) => acc + curr.distance, 0);
  document.getElementById('gauge-miles-num').textContent = totalMilesAllTime.toFixed(1) + " mi";

  updateServiceStatusIndicators();
  renderVolumeChart();
  renderCoachAdvice(currentTrainingWeek, actualWeekMiles);
  renderYtdStats();
  renderAthleteIntelligenceTrends();
  
  // Toggle Plan Recalibrate button
  const recalBtn = document.getElementById('btn-recalibrate-plan');
  if (recalBtn) {
    recalBtn.style.display = appState.trainingPlan ? 'block' : 'none';
  }
}

function updateServiceStatusIndicators() {
  const garminDot = document.getElementById('sidebar-garmin-dot');
  const garminText = document.getElementById('sidebar-garmin-status');
  const garminBeacon = document.getElementById('garmin-beacon-dot');
  const garminStatusLabel = document.getElementById('garmin-status-label');
  const garminCard = document.getElementById('btn-garmin-connect');

  if (appState.apiConfig.garmin_connected) {
    garminDot.className = "indicator-dot connected";
    garminText.textContent = "Synced";
    garminBeacon.className = "indicator-dot connected";
    garminStatusLabel.textContent = "Connected & Active";
    garminCard.style.borderColor = "rgba(6, 182, 212, 0.3)";
    garminCard.style.background = "rgba(6, 182, 212, 0.03)";
  } else if (appState.apiConfig.garmin_configured) {
    garminDot.className = "indicator-dot";
    garminText.textContent = "Configured";
    garminBeacon.className = "indicator-dot syncing";
    garminStatusLabel.textContent = "Credentials Set (Click to Sync)";
    garminCard.style.borderColor = "rgba(6, 182, 212, 0.15)";
    garminCard.style.background = "rgba(6, 182, 212, 0.01)";
  } else {
    garminDot.className = "indicator-dot";
    garminText.textContent = "Disconnected";
    garminBeacon.className = "indicator-dot";
    garminStatusLabel.textContent = "Click to Connect";
    garminCard.style.borderColor = "";
    garminCard.style.background = "";
  }

  const stravaDot = document.getElementById('sidebar-strava-dot');
  const stravaText = document.getElementById('sidebar-strava-status');
  const stravaBeacon = document.getElementById('strava-beacon-dot');
  const stravaStatusLabel = document.getElementById('strava-status-label');
  const stravaCard = document.getElementById('btn-strava-connect');

  if (appState.apiConfig.strava_connected) {
    stravaDot.className = "indicator-dot connected";
    stravaText.textContent = "Synced";
    stravaBeacon.className = "indicator-dot connected";
    stravaStatusLabel.textContent = "Connected (Sync Live)";
    stravaCard.style.borderColor = "rgba(252, 76, 2, 0.3)";
    stravaCard.style.background = "rgba(252, 76, 2, 0.03)";
  } else if (appState.apiConfig.strava_configured) {
    stravaDot.className = "indicator-dot";
    stravaText.textContent = "Configured";
    stravaBeacon.className = "indicator-dot syncing";
    stravaStatusLabel.textContent = "Credentials Set (Click to Auth)";
    stravaCard.style.borderColor = "rgba(252, 76, 2, 0.15)";
    stravaCard.style.background = "rgba(252, 76, 2, 0.01)";
  } else {
    stravaDot.className = "indicator-dot";
    stravaText.textContent = "Disconnected";
    stravaBeacon.className = "indicator-dot";
    stravaStatusLabel.textContent = "Click to Configure API";
    stravaCard.style.borderColor = "";
    stravaCard.style.background = "";
  }
}

function calculateWeekActualMiles(weekNum) {
  return appState.activities
    .filter(act => act.week === weekNum)
    .reduce((acc, curr) => acc + curr.distance, 0);
}

function countPlanTotalRuns() {
  if (!appState.trainingPlan) return 0;
  let count = 0;
  appState.trainingPlan.forEach(week => {
    week.schedule.forEach(day => {
      if (day.distance > 0) count++;
    });
  });
  return count;
}

function calculateAveragePace() {
  const runningActivities = appState.activities.filter(a => 
    (a.type === 'Run' || a.type === 'Aerobic Base Run' || a.type === 'Zone 2 Recovery' || a.type.toLowerCase().includes('run')) && 
    a.duration > 0 && a.distance > 0
  );
  if (runningActivities.length === 0) return { paceSeconds: 0, paceStr: "0:00" };
  
  const totalMin = runningActivities.reduce((acc, curr) => acc + curr.duration, 0);
  const totalDist = runningActivities.reduce((acc, curr) => acc + curr.distance, 0);
  
  const avgPaceDecimal = totalMin / totalDist;
  const mins = Math.floor(avgPaceDecimal);
  const secs = Math.round((avgPaceDecimal - mins) * 60);
  
  return {
    paceSeconds: avgPaceDecimal * 60,
    paceStr: `${mins}:${secs < 10 ? '0' + secs : secs}`
  };
}

function calculateTargetPaceStr() {
  const t = appState.targetTime;
  if (t === "3:00:00") return "6:52";
  if (t === "3:30:00") return "8:00";
  if (t === "4:00:00") return "9:09";
  if (t === "4:30:00") return "10:18";
  if (t === "5:00:00") return "11:27";
  return "8:30";
}

// ----------------------------------------------------
// DYNAMIC SVG CHART CREATOR
// ----------------------------------------------------
function renderVolumeChart() {
  const svg = document.getElementById('volume-chart-svg');
  if (!svg) return;
  
  const paths = svg.querySelectorAll('.chart-dynamic');
  paths.forEach(p => p.remove());

  const width = svg.clientWidth || 700;
  const height = 250;
  
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  let maxVolume = 50;
  if (appState.trainingPlan) {
    appState.trainingPlan.forEach(w => {
      if (w.plannedVolume > maxVolume) maxVolume = w.plannedVolume;
    });
  }
  maxVolume = Math.ceil((maxVolume + 5) / 10) * 10;

  const gridLinesCount = 5;
  for (let i = 0; i <= gridLinesCount; i++) {
    const val = (maxVolume / gridLinesCount) * i;
    const y = padT + chartH - (chartH * (i / gridLinesCount));
    
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "chart-grid-line chart-dynamic");
    line.setAttribute("x1", padL);
    line.setAttribute("y1", y);
    line.setAttribute("x2", width - padR);
    line.setAttribute("y2", y);
    svg.appendChild(line);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "chart-grid-text chart-dynamic");
    text.setAttribute("x", padL - 10);
    text.setAttribute("y", y + 4);
    text.setAttribute("text-anchor", "end");
    text.textContent = Math.round(val);
    svg.appendChild(text);
  }

  const pointsPlanned = [];
  const pointsActual = [];

  for (let w = 1; w <= 16; w++) {
    const x = padL + (chartW * ((w - 1) / 15));
    
    let plannedVol = 0;
    if (appState.trainingPlan && appState.trainingPlan[w-1]) {
      plannedVol = appState.trainingPlan[w-1].plannedVolume;
    }
    const yPlanned = padT + chartH - (chartH * (plannedVol / maxVolume));
    pointsPlanned.push({ x, y: yPlanned, vol: plannedVol, week: w });

    const actualVol = calculateWeekActualMiles(w);
    const yActual = padT + chartH - (chartH * (actualVol / maxVolume));
    
    if (w <= appState.activeWeek || actualVol > 0) {
      pointsActual.push({ x, y: yActual, vol: actualVol, week: w });
    }

    if (w === 1 || w % 2 === 0) {
      const textX = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textX.setAttribute("class", "chart-grid-text chart-dynamic");
      textX.setAttribute("x", x);
      textX.setAttribute("y", height - 5);
      textX.setAttribute("text-anchor", "middle");
      textX.textContent = `W${w}`;
      svg.appendChild(textX);
    }
  }

  if (pointsPlanned.length > 1) {
    let dAttr = `M ${pointsPlanned[0].x} ${pointsPlanned[0].y}`;
    for (let i = 1; i < pointsPlanned.length; i++) {
      dAttr += ` L ${pointsPlanned[i].x} ${pointsPlanned[i].y}`;
    }
    const pathPlanned = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathPlanned.setAttribute("class", "chart-line-target chart-dynamic");
    pathPlanned.setAttribute("d", dAttr);
    svg.appendChild(pathPlanned);
  }

  if (pointsActual.length > 1) {
    let dCurve = `M ${pointsActual[0].x} ${pointsActual[0].y}`;
    for (let i = 1; i < pointsActual.length; i++) {
      const cpX1 = pointsActual[i-1].x + (pointsActual[i].x - pointsActual[i-1].x) / 2;
      const cpY1 = pointsActual[i-1].y;
      const cpX2 = pointsActual[i-1].x + (pointsActual[i].x - pointsActual[i-1].x) / 2;
      const cpY2 = pointsActual[i].y;
      dCurve += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${pointsActual[i].x} ${pointsActual[i].y}`;
    }

    const dArea = `${dCurve} L ${pointsActual[pointsActual.length - 1].x} ${padT + chartH} L ${pointsActual[0].x} ${padT + chartH} Z`;
    
    const areaEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    areaEl.setAttribute("class", "chart-area-volume chart-dynamic");
    areaEl.setAttribute("d", dArea);
    svg.appendChild(areaEl);

    const lineEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    lineEl.setAttribute("class", "chart-line-volume chart-dynamic");
    lineEl.setAttribute("d", dCurve);
    svg.appendChild(lineEl);
  }

  pointsActual.forEach(pt => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "chart-datapoint chart-dynamic");
    circle.setAttribute("cx", pt.x);
    circle.setAttribute("cy", pt.y);
    circle.setAttribute("r", 5);
    
    circle.addEventListener('mouseenter', (e) => {
      showChartTooltip(e, pt.week, pt.vol);
    });
    circle.addEventListener('mousemove', (e) => {
      positionChartTooltip(e);
    });
    circle.addEventListener('mouseleave', () => {
      hideChartTooltip();
    });

    svg.appendChild(circle);
  });
}

function showChartTooltip(event, week, volume) {
  const tooltip = document.getElementById('chart-tooltip-el');
  if (!tooltip) return;
  
  let plannedVol = 0;
  if (appState.trainingPlan && appState.trainingPlan[week-1]) {
    plannedVol = appState.trainingPlan[week-1].plannedVolume;
  }

  tooltip.innerHTML = `
    <div class="chart-tooltip-header">Week ${week} Analytics</div>
    <div class="chart-tooltip-body">Logged: <b>${volume.toFixed(1)} miles</b></div>
    <div style="color: var(--text-muted); font-size: 0.65rem;">Scheduled: ${plannedVol} miles</div>
  `;
  tooltip.style.display = 'block';
  positionChartTooltip(event);
}

function positionChartTooltip(event) {
  const tooltip = document.getElementById('chart-tooltip-el');
  if (!tooltip) return;
  const chartBox = tooltip.parentElement.getBoundingClientRect();
  const x = event.clientX - chartBox.left + 15;
  const y = event.clientY - chartBox.top - 40;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideChartTooltip() {
  const tooltip = document.getElementById('chart-tooltip-el');
  if (tooltip) tooltip.style.display = 'none';
}

// ----------------------------------------------------
// AI COACH ENGINE & AUTOMATED REVIEWS
// ----------------------------------------------------
function renderCoachAdvice(weekNum, weekMiles) {
  const coachDigest = document.getElementById('coach-digest-text');
  const workoutTitle = document.getElementById('coach-today-workout-title');
  const workoutDesc = document.getElementById('coach-today-workout-desc');
  const workoutBadge = document.getElementById('coach-today-workout-badge');
  const coachUpdatedText = document.getElementById('coach-last-updated');

  if (!appState.trainingPlan) {
    coachDigest.textContent = "Generate a Marathon Plan to kick off your AeroAI coach reviews!";
    return;
  }

  coachUpdatedText.textContent = "AI Analysis updated just now";

  const jsDay = new Date().getDay();
  const targetDayMap = [6, 0, 1, 2, 3, 4, 5];
  const todayIndex = targetDayMap[jsDay];
  
  const activePlanWeek = appState.trainingPlan[weekNum - 1];
  let todayWorkout = null;
  if (activePlanWeek) {
    todayWorkout = activePlanWeek.schedule[todayIndex];
  }

  if (todayWorkout) {
    workoutTitle.textContent = todayWorkout.distance > 0 
      ? `${todayWorkout.distance}mi ${todayWorkout.type}` 
      : `Rest / Dynamic Recovery`;
    workoutDesc.textContent = todayWorkout.description;
    workoutBadge.textContent = todayWorkout.distance > 0 ? todayWorkout.type.split(" ")[0] : "Recovery";
    
    if (todayWorkout.distance === 0) {
      workoutBadge.style.background = "rgba(255, 255, 255, 0.05)";
      workoutBadge.style.color = "var(--text-muted)";
      workoutBadge.style.borderColor = "var(--card-border)";
    } else if (todayWorkout.type.includes("Long")) {
      workoutBadge.style.background = "rgba(6, 182, 212, 0.15)";
      workoutBadge.style.color = "var(--secondary)";
      workoutBadge.style.borderColor = "var(--secondary-glow)";
    } else if (todayWorkout.type.includes("Tempo") || todayWorkout.type.includes("Interval")) {
      workoutBadge.style.background = "rgba(99, 102, 241, 0.15)";
      workoutBadge.style.color = "var(--primary)";
      workoutBadge.style.borderColor = "var(--primary-glow)";
    } else {
      workoutBadge.style.background = "rgba(16, 185, 129, 0.15)";
      workoutBadge.style.color = "var(--accent)";
      workoutBadge.style.borderColor = "var(--accent-glow)";
    }
  }

  let adviceStr = "";
  const planTargetVol = activePlanWeek ? activePlanWeek.plannedVolume : 30;
  const goodSleep = appState.bioIndicators.sleep;
  const noSoreness = appState.bioIndicators.soreness;

  if (weekNum <= 4) {
    adviceStr = "✦ <b>Base Building Focus:</b> We are currently strengthening your joints, ligaments, and mitochondrial base. Keep your easy paces strictly aerobic (Zone 2). Consistency is the ultimate priority in this block.";
  } else if (weekNum <= 8) {
    adviceStr = "✦ <b>Strength & Speed Expansion:</b> We've introduced lactate threshold blocks. Focus on progressive acceleration on your Saturday long runs, keeping the first half fully relaxed.";
  } else if (weekNum <= 12) {
    adviceStr = "✦ <b>Peak Training Cycle:</b> High mileage block. Ensure you are consuming plenty of complex carbohydrates 36 hours before your long run. Do not skip recovery walking jogs.";
  } else {
    adviceStr = "✦ <b>Marathon Taper Phase:</b> We are dropping weekly volume by 20-50% to supercompensate muscle glycogen stores. Keep pace sharp but short. Sleep and hydration are your actual workouts now.";
  }

  if (!goodSleep) {
    adviceStr += "<br><br><span style='color: var(--warning)'>⚠ <b>Sleep Quality Alert:</b> You reported suboptimal sleep. Your central nervous system requires rest. If you feel sluggish during today's workout, truncate the mileage by 20% and run strictly easy. Avoid hard speeds today.</span>";
  }
  if (!noSoreness) {
    adviceStr += "<br><br><span style='color: var(--danger)'>⚠ <b>Recovery Notice:</b> You flagged minor muscle soreness or joint ache. Foam roll your calves/hamstrings and spend 10 extra minutes on active mobility. If pain is acute or localized on shinbones, take a full rest day immediately to prevent stress injuries.</span>";
  }

  const weeklyActual = calculateWeekActualMiles(weekNum);
  if (weeklyActual >= planTargetVol * 0.95 && weeklyActual <= planTargetVol * 1.1) {
    adviceStr += "<br><br><span style='color: var(--accent)'>✓ <b>Volume Target Achieved!</b> You are perfectly matching the periodized load curve for this week. Superb discipline.</span>";
  } else if (weeklyActual > planTargetVol * 1.15) {
    adviceStr += "<br><br><span style='color: var(--warning)'>⚠ <b>Injury Warning:</b> You have exceeded your weekly target plan by more than 15%. Spiking running volume too quickly is the #1 cause of running injuries. Cap your remaining sessions to avoid overloading.</span>";
  }

  coachDigest.innerHTML = adviceStr;
}

function toggleBioCheck(element, indicator) {
  element.classList.toggle('checked');
  appState.bioIndicators[indicator] = element.classList.contains('checked');
  saveStateToServer();
  
  const actualWeekMiles = calculateWeekActualMiles(appState.activeWeek);
  renderCoachAdvice(appState.activeWeek, actualWeekMiles);
}

// ----------------------------------------------------
// 16-WEEK PERIODIZED TRAINING PLAN BUILDER
// ----------------------------------------------------
function openPlanModal() {
  document.getElementById('modal-plan-generator').classList.add('active');
}

function closePlanModal() {
  document.getElementById('modal-plan-generator').classList.remove('active');
}

async function generateMarathonPlan(event) {
  event.preventDefault();
  
  const mDate = document.getElementById('form-marathon-date').value;
  const tTime = document.getElementById('form-target-time').value;
  const wMiles = parseInt(document.getElementById('form-weekly-miles').value);
  const exp = document.getElementById('form-experience').value;

  appState.marathonDate = mDate;
  appState.targetTime = tTime;
  appState.weeklyMiles = wMiles;
  appState.experience = exp;

  appState.trainingPlan = generatePlanArray(exp, wMiles, tTime);
  appState.completedWorkouts = {};
  
  const today = new Date();
  const target = new Date(mDate);
  const daysDiff = Math.ceil((target.getTime() - today.getTime()) / (1000 * 3600 * 24));
  
  let startingWeek = 1;
  if (daysDiff > 0) {
    startingWeek = Math.max(1, Math.min(16, 17 - Math.ceil(daysDiff / 7)));
  }
  appState.activeWeek = startingWeek;
  
  await saveStateToServer();
  closePlanModal();
  updateDashboardUI();
  renderWeeklyPlanCalendar();
  
  showToast(`Assembled 16-week ${exp} plan. Peak target: ${appState.trainingPlan[11].plannedVolume} miles.`, "success");
}

function generatePlanArray(experience, baseMileage, targetTime) {
  let peakMultiplier = 1.4;
  if (experience === "novice") peakMultiplier = 1.25;
  if (experience === "advanced") peakMultiplier = 1.6;

  const peakMileage = Math.round(baseMileage * peakMultiplier);
  const plans = [];

  for (let w = 1; w <= 16; w++) {
    let weekVolume = baseMileage;
    let phase = "Base Building";
    let desc = "Developing aerobic base, strengthening muscular skeletal framework.";
    
    if (w <= 4) {
      weekVolume = Math.round(baseMileage + ((peakMileage - baseMileage) * 0.2) * (w / 4));
      phase = "Base Building Phase";
    } else if (w <= 8) {
      weekVolume = Math.round(baseMileage + (peakMileage - baseMileage) * (0.3 + (0.5 * ((w - 4) / 4))));
      phase = "Aerobic Expansion Phase";
      desc = "Adding strength strides, hilly courses, and midweek speed blocks.";
    } else if (w <= 12) {
      weekVolume = Math.round(baseMileage + (peakMileage - baseMileage) * (0.8 + (0.2 * ((w - 8) / 4))));
      phase = "Peak Volume Block";
      desc = "Maximum endurance blocks. Building specific marathon race pace muscle memory.";
      if (w === 10) {
        weekVolume = Math.round(weekVolume * 0.8);
        desc = "Step-back recovery week to absorb the high volume peak training loads.";
      }
    } else {
      const taperWeeks = w - 12;
      if (taperWeeks === 1) weekVolume = Math.round(peakMileage * 0.8);
      else if (taperWeeks === 2) weekVolume = Math.round(peakMileage * 0.6);
      else if (taperWeeks === 3) weekVolume = Math.round(peakMileage * 0.45);
      else {
        weekVolume = Math.round(peakMileage * 0.25);
      }
      phase = "Marathon Taper Phase";
      desc = "Glycogen restoration, muscle recovery, maintaining fast neurological strides.";
    }

    const schedule = generateDailyWorkouts(w, weekVolume, phase, targetTime);
    
    plans.push({
      weekNum: w,
      phaseName: phase,
      phaseDesc: desc,
      plannedVolume: weekVolume,
      schedule: schedule
    });
  }

  return plans;
}

function generateDailyWorkouts(weekNum, weekVol, phase, targetTime) {
  const schedule = [];
  
  let targetPaceDecimal = 8.5;
  if (targetTime === "3:00:00") targetPaceDecimal = 6.87;
  else if (targetTime === "3:30:00") targetPaceDecimal = 8.0;
  else if (targetTime === "4:00:00") targetPaceDecimal = 9.15;
  else if (targetTime === "4:30:00") targetPaceDecimal = 10.3;
  else if (targetTime === "5:00:00") targetPaceDecimal = 11.45;

  const easyPace = formatPace(targetPaceDecimal + 1.25);
  const marathonPace = formatPace(targetPaceDecimal);
  const tempoPace = formatPace(targetPaceDecimal - 0.5);

  if (weekNum === 16) {
    return [
      { day: "Monday", distance: 0, type: "Rest Day", description: "Full rest. Walk, stretch, keep legs fresh.", pace: "--" },
      { day: "Tuesday", distance: 3.0, type: "Aerobic Base Run", description: `Super easy stride check. Keep pace locked at ${easyPace}/mi.`, pace: easyPace },
      { day: "Wednesday", distance: 0, type: "Rest Day", description: "Rest. High hydration, start light carbohydrate-loading.", pace: "--" },
      { day: "Thursday", distance: 2.0, type: "Zone 2 Recovery", description: `Active recovery. Very light jog. Include 3x 100m strides.`, pace: easyPace },
      { day: "Friday", distance: 0, type: "Rest Day", description: "Rest. Lay out race gear, final glycogen storage carb meals.", pace: "--" },
      { day: "Saturday", distance: 1.5, type: "Zone 2 Recovery", description: "Shakeout jog. Warm up joints, keep nervous system active.", pace: easyPace },
      { day: "Sunday", distance: 26.2, type: "Marathon Race Day", description: `THE BIG DAY! Stick strictly to target pace: ${marathonPace}/mi. Trust the block!`, pace: marathonPace }
    ];
  }

  schedule.push({ day: "Monday", distance: 0, type: "Rest Day", description: "Rest. Active foam rolling and deep hamstring/calf stretching.", pace: "--" });

  let tueDist = Math.round(weekVol * 0.18);
  if (phase.includes("Base")) {
    schedule.push({ day: "Tuesday", distance: tueDist, type: "Aerobic Base Run", description: `Base volume jog. Target easy pace: ${easyPace}/mi.`, pace: easyPace });
  } else if (phase.includes("Expansion")) {
    schedule.push({ day: "Tuesday", distance: tueDist, type: "Threshold Interval Session", description: `Warm up 1.5mi. 4x 1km intervals at tempo pace: ${tempoPace}/mi. Cool down 1mi.`, pace: tempoPace });
  } else if (phase.includes("Peak")) {
    schedule.push({ day: "Tuesday", distance: tueDist, type: "Threshold Interval Session", description: `Warm up 2mi. 3x 1.5mi threshold intervals at ${tempoPace}/mi with 3min rest. Cool down 1.5mi.`, pace: tempoPace });
  } else {
    schedule.push({ day: "Tuesday", distance: Math.round(tueDist * 0.8), type: "Aerobic Base Run", description: `Fresh taper run. Speed sharp, volume low. Pace: ${easyPace}/mi.`, pace: easyPace });
  }

  let wedDist = Math.round(weekVol * 0.12);
  if (wedDist < 3) {
    schedule.push({ day: "Wednesday", distance: 0, type: "Rest Day", description: "Rest day. Dynamic core strengthening and light walk.", pace: "--" });
  } else {
    schedule.push({ day: "Wednesday", distance: wedDist, type: "Zone 2 Recovery", description: `Recovery run. Protect your knees. Keep heart rate low, pace: ${easyPace}/mi.`, pace: easyPace });
  }

  let thuDist = Math.round(weekVol * 0.22);
  if (phase.includes("Peak")) {
    schedule.push({ day: "Thursday", distance: thuDist, type: "Aerobic Base Run", description: `Marathon specific pacing block. 2mi easy, then ${thuDist - 4}mi locked at race pace: ${marathonPace}/mi.`, pace: marathonPace });
  } else {
    schedule.push({ day: "Thursday", distance: thuDist, type: "Aerobic Base Run", description: `Aerobic baseline run. Focus on tall running form. Pace: ${easyPace}/mi.`, pace: easyPace });
  }

  schedule.push({ day: "Friday", distance: 0, type: "Rest Day", description: "Full rest day. Rest muscle fibers before the big weekend long run.", pace: "--" });

  let satDist = Math.round(weekVol * 0.38);
  if (satDist > 20 && experience !== "advanced") satDist = 20;
  
  if (phase.includes("Base")) {
    schedule.push({ day: "Saturday", distance: satDist, type: "Progressive Long Run", description: `Progressive aerobic long run. Start slow, finish last 2 miles strong. Pace: ${easyPace}/mi.`, pace: easyPace });
  } else if (phase.includes("Expansion")) {
    schedule.push({ day: "Saturday", distance: satDist, type: "Progressive Long Run", description: `Endurance builder. Incorporate last 3 miles at marathon race pace: ${marathonPace}/mi.`, pace: marathonPace });
  } else if (phase.includes("Peak")) {
    schedule.push({ day: "Saturday", distance: satDist, type: "Progressive Long Run", description: `Peak endurance test. First half at ${easyPace}/mi, second half locked at ${marathonPace}/mi. Fuel every 45m.`, pace: marathonPace });
  } else {
    schedule.push({ day: "Saturday", distance: satDist, type: "Progressive Long Run", description: `Taper long run. Keep leg muscles loose, protect cardiovascular tone. Pace: ${easyPace}/mi.`, pace: easyPace });
  }

  let sunDist = Math.round(weekVol * 0.1);
  if (sunDist < 3) {
    schedule.push({ day: "Sunday", distance: 0, type: "Rest Day", description: "Sunday recovery. High hydration, light stroll in park.", pace: "--" });
  } else {
    schedule.push({ day: "Sunday", distance: sunDist, type: "Zone 2 Recovery", description: `Active recovery flush run. Clears muscle fatigue. Keep pace strictly easy: ${easyPace}/mi.`, pace: easyPace });
  }

  let sum = schedule.reduce((acc, curr) => acc + curr.distance, 0);
  let diff = weekVol - sum;
  if (Math.abs(diff) > 0 && schedule[1].distance > 0) {
    schedule[1].distance = Math.max(1, Math.round(schedule[1].distance + diff));
  }

  return schedule;
}

function formatPace(decimalPace) {
  const mins = Math.floor(decimalPace);
  const secs = Math.round((decimalPace - mins) * 60);
  return `${mins}:${secs < 10 ? '0' + secs : secs}`;
}

// ----------------------------------------------------
// 16-WEEK PLAN CALENDAR RENDERING
// ----------------------------------------------------
let activeSelectedWeekTab = 1;

function renderWeeklyPlanCalendar() {
  const tabsRow = document.getElementById('weeks-tab-row');
  const daysGrid = document.getElementById('weekly-days-grid');
  const phaseSubtitle = document.getElementById('plan-phase-subtitle');
  
  if (!tabsRow || !daysGrid) return;
  if (!appState.trainingPlan) {
    daysGrid.innerHTML = `
      <div class="col-12 empty-activity-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 4H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-9 14H7v-2h3v2zm0-4H7v-2h3v2zm0-4H7V8h3v2zm8 8h-6v-2h6v2zm0-4h-6v-2h6v2zm0-4h-6V8h6v2z"/></svg>
        <h3>No training calendar generated</h3>
        <p>Click "Marathon Plan Generator" above to build a custom 16-week periodized schedule tailored to your target marathon.</p>
      </div>
    `;
    return;
  }

  if (activeSelectedWeekTab === 1 && appState.activeWeek > 1) {
    activeSelectedWeekTab = appState.activeWeek;
  }

  tabsRow.innerHTML = "";
  appState.trainingPlan.forEach(week => {
    const tab = document.createElement('div');
    tab.className = `plan-week-tab ${week.weekNum === activeSelectedWeekTab ? 'active' : ''}`;
    tab.textContent = `Week ${week.weekNum}`;
    
    let allDone = true;
    let hasRuns = false;
    week.schedule.forEach((day, index) => {
      if (day.distance > 0) {
        hasRuns = true;
        const key = `${week.weekNum}-${index}`;
        if (!appState.completedWorkouts[key]) allDone = false;
      }
    });
    if (allDone && hasRuns) tab.textContent += " ✓";

    tab.addEventListener('click', () => {
      activeSelectedWeekTab = week.weekNum;
      renderWeeklyPlanCalendar();
    });
    tabsRow.appendChild(tab);
  });

  const currentPlanWeek = appState.trainingPlan[activeSelectedWeekTab - 1];
  phaseSubtitle.innerHTML = `<b>Phase ${activeSelectedWeekTab}/16: ${currentPlanWeek.phaseName}</b> — ${currentPlanWeek.phaseDesc} (Target Volume: <b>${currentPlanWeek.plannedVolume} mi</b>)`;

  daysGrid.innerHTML = "";
  currentPlanWeek.schedule.forEach((workout, dayIndex) => {
    const key = `${activeSelectedWeekTab}-${dayIndex}`;
    const isCompleted = !!appState.completedWorkouts[key];
    
    const card = document.createElement('div');
    card.className = `day-workout-card ${workout.distance === 0 ? 'rest-day' : ''} ${isCompleted ? 'workout-completed' : ''}`;
    
    card.innerHTML = `
      <div class="day-label">
        <span>${workout.day}</span>
        <span style="font-size: 0.65rem; color: var(--text-muted)">Day ${dayIndex + 1}</span>
      </div>
      <div class="day-workout-desc">${workout.description}</div>
      <div class="day-workout-miles">
        ${workout.distance > 0 ? `${workout.distance.toFixed(1)} mi <span style="font-size: 0.7rem; font-weight: normal; color: var(--text-muted)">@ ${workout.pace}/mi</span>` : 'Rest Day'}
      </div>
    `;

    card.addEventListener('dblclick', () => {
      toggleWorkoutCompletion(activeSelectedWeekTab, dayIndex, workout);
    });

    card.setAttribute('title', "Double click to mark as completed!");
    daysGrid.appendChild(card);
  });
}

async function toggleWorkoutCompletion(week, dayIndex, workout) {
  const key = `${week}-${dayIndex}`;
  
  if (appState.completedWorkouts[key]) {
    delete appState.completedWorkouts[key];
    showToast(`Removed Week ${week} ${workout.day} run from completed log.`, "info");
  } else {
    appState.completedWorkouts[key] = true;
    
    if (workout.distance > 0) {
      const paceParts = workout.pace.split(':');
      let paceSeconds = 8.5 * 60;
      if (paceParts.length === 2) {
        paceSeconds = parseInt(paceParts[0]) * 60 + parseInt(paceParts[1]);
      }
      const durationMin = Math.round((workout.distance * paceSeconds) / 60);

      const newAct = {
        id: 'act-completed-' + Date.now(),
        name: `Plan Completed: ${workout.type}`,
        type: workout.type,
        distance: workout.distance,
        duration: durationMin,
        avgHeartRate: workout.type.includes('Tempo') || workout.type.includes('Interval') ? 154 : 138,
        date: new Date().toISOString().split('T')[0],
        provider: appState.apiConfig.strava_connected ? 'strava' : 'garmin',
        week: week,
        day: dayIndex,
        completed: true
      };
      
      appState.activities.push(newAct);
      
      // Save to server database
      try {
        await fetch('/api/activities/add', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(newAct)
        });
      } catch (err) {}
    }
    
    showToast(`Completed Week ${week} ${workout.day}! Great run!`, "success");
  }
  
  await saveStateToServer();
  updateDashboardUI();
  renderWeeklyPlanCalendar();
  renderActivitiesList();
}

// ----------------------------------------------------
// ACTIVITY FEED & LOG SYSTEM
// ----------------------------------------------------
function renderActivitiesList() {
  const container = document.getElementById('activity-list-container');
  if (!container) return;

  if (appState.activities.length === 0) {
    container.innerHTML = `
      <div class="empty-activity-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
        <h3>No activities synchronized</h3>
        <p>Integrate Garmin or Strava profiles, or run custom integrations to build your activity feed.</p>
      </div>
    `;
    return;
  }

  const sorted = [...appState.activities].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Sport icon SVG map
  const SPORT_ICONS = {
    Run: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="4" r="2"/><path d="M10 7l-3 8 3-1 1 4 3-5-3-1 1-5z"/><path d="M14 7l2 2 2-1"/></svg>`,
    Ride: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M5 17l4-9h6l2 5h-4l-2 4"/><circle cx="12" cy="7" r="1.5"/></svg>`,
    Swim: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12c1.5 2 3.5 2 5 0s3.5-2 5 0 3.5 2 5 0"/><path d="M2 17c1.5 2 3.5 2 5 0s3.5-2 5 0 3.5 2 5 0"/><circle cx="17" cy="5" r="2"/><path d="M17 7v4l-3 2"/></svg>`,
    Walk: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="4" r="2"/><path d="M9 11l1-4 2 2 3-3"/><path d="M9 22l1-7 3 3 2-7"/></svg>`,
    Strength: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6h4m4 0h4M8 6V4m8 2V4M4 10h16M8 10v8m8-8v8M4 14h2m12 0h2"/></svg>`,
    Other: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>`
  };

  const SPORT_LABELS = {
    Run: 'Run', Ride: 'Cycling', Swim: 'Swimming', Walk: 'Walk/Hike',
    Strength: 'Strength', Other: 'Cross-Train'
  };

  container.innerHTML = "";
  sorted.forEach(act => {
    const card = document.createElement('div');
    card.className = `activity-card ${act.completed ? 'completed-workout' : ''}`;

    // Determine sport key from activity type string
    const sportKey = (['Run','Ride','Swim','Walk','Strength'].find(k =>
      act.type.includes(k) || (k === 'Ride' && act.type.toLowerCase().includes('cycl'))
    )) || 'Other';

    const sportIcon = SPORT_ICONS[sportKey] || SPORT_ICONS.Other;
    const sportLabel = SPORT_LABELS[sportKey] || sportKey;

    // Pace only meaningful for distance sports; guard divide-by-zero
    let paceStr = '--:--';
    if (act.distance > 0 && act.duration > 0) {
      const totalPaceSec = (act.duration * 60) / act.distance;
      const paceMin = Math.floor(totalPaceSec / 60);
      const paceSec = Math.round(totalPaceSec % 60);
      paceStr = `${paceMin}:${paceSec < 10 ? '0' + paceSec : paceSec}`;
    }

    const metricLabel = sportKey === 'Strength' ? 'duration' : 'miles';
    const metricVal = sportKey === 'Strength' ? act.duration : act.distance.toFixed(1);
    
    // Generate the AI summary went-well / can-improve details
    const ai = generateActivityAISummary(act);

    card.innerHTML = `
      <div class="activity-card-header">
        <div class="activity-icon-container">
          ${sportIcon}
        </div>
        <div class="activity-info">
          <h4>${act.name}</h4>
          <p>
            <span style="font-size:0.7rem; color:var(--secondary); font-weight:600; text-transform:uppercase; letter-spacing:0.05em">${sportLabel}</span>
            &bull; ${act.date} &bull; ${act.week >= 1 ? `Week ${act.week}` : 'Pre-Training'}
          </p>
          <span class="activity-provider-tag tag-${act.provider}">
            ${act.provider.toUpperCase()} SYNCED
          </span>
        </div>
        <div class="activity-metrics">
          <div class="activity-metric-col">
            <span class="activity-metric-val">${metricVal}</span>
            <span class="activity-metric-lbl">${metricLabel}</span>
          </div>
          ${sportKey !== 'Strength' ? `
          <div class="activity-metric-col">
            <span class="activity-metric-val">${paceStr}</span>
            <span class="activity-metric-lbl">/mi pace</span>
          </div>` : ''}
          <div class="activity-metric-col">
            <span class="activity-metric-val">${act.avgHeartRate || '--'}</span>
            <span class="activity-metric-lbl">bpm avg</span>
          </div>
          <div class="activity-metric-col">
            <span class="activity-metric-val">${act.duration}</span>
            <span class="activity-metric-lbl">minutes</span>
          </div>
        </div>
        <div class="activity-expand-arrow">
          <svg style="width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.5;" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </div>
      </div>
      
      <div class="activity-card-details">
        <div class="ai-blurb-box">
          <h5>
            <svg style="width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2.5; vertical-align: middle; margin-right: 0.25rem;" viewBox="0 0 24 24">
              <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
            </svg>
            Coach Aero's AI Performance Assessment
          </h5>
          <p class="ai-summary-text">${ai.summary}</p>
          
          <div class="ai-points-row">
            <div class="ai-points-col">
              <span class="ai-point-header went-well">🟢 What Went Well</span>
              <ul>
                ${ai.wentWell.map(w => `<li>${w}</li>`).join('')}
              </ul>
            </div>
            <div class="ai-points-col">
              <span class="ai-point-header can-improve">🟡 What Can Improve</span>
              <ul>
                ${ai.canImprove.map(c => `<li>${c}</li>`).join('')}
              </ul>
            </div>
          </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.85rem;">
          <button class="btn btn-secondary btn-sm" style="padding: 0.35rem 0.75rem; font-size: 0.7rem; border-radius: 6px;" onclick="event.stopPropagation(); toggleInlineChat('${act.id}')">
            ✦ Say More with Coach Aero
          </button>
          ${sportKey === 'Run' ? `
          <button class="btn btn-secondary btn-sm" style="padding: 0.35rem 0.75rem; font-size: 0.7rem; border-radius: 6px;" onclick="event.stopPropagation(); openReviewModalById('${act.id}')">
            View Heart-Rate Decoupling &amp; Zones
          </button>` : ''}
        </div>
        
        <!-- Inline chat container, initially hidden -->
        <div class="activity-chat-container" id="chat-container-${act.id}" style="display: none;" onclick="event.stopPropagation();">
          <div class="activity-chat-log" id="chat-log-${act.id}">
            <div class="chat-msg-row coach">
              <div class="chat-msg-bubble">
                Hey there! I've analyzed your <b>${act.name}</b>. Ask me anything about your pace zones, aerobic efficiency, or recovery suggestions!
              </div>
            </div>
          </div>
          
          <div class="chat-prompt-chips">
            <div class="chat-prompt-chip" onclick="clickInlinePromptChip(this, 'How was my cardiovascular load and drift?', '${act.id}')">🩺 Cardiovascular load?</div>
            <div class="chat-prompt-chip" onclick="clickInlinePromptChip(this, 'What should I focus on for my next session?', '${act.id}')">🏃 Next workout focus?</div>
            <div class="chat-prompt-chip" onclick="clickInlinePromptChip(this, 'Give me a specific dynamic recovery stretch.', '${act.id}')">🧘 Recovery stretch?</div>
          </div>
          
          <form class="activity-chat-input-row" onsubmit="submitInlineChatMessage(event, '${act.id}')">
            <input type="text" class="activity-chat-input" id="chat-input-${act.id}" placeholder="Ask Coach Aero a question..." required>
            <button type="submit" class="btn btn-primary btn-sm" style="height:34px; padding: 0 0.75rem; font-size:0.75rem; border-radius:6px;">Send</button>
          </form>
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      // If we are clicking inside input or form or chat log, do NOT collapse card
      if (e.target.closest('.activity-chat-container') || e.target.closest('button')) {
        return;
      }
      const isExpanded = card.classList.contains('expanded');
      
      // Collapse all other cards first for a clean accordian transition
      document.querySelectorAll('.activity-card').forEach(c => c.classList.remove('expanded'));
      
      if (!isExpanded) {
        card.classList.add('expanded');
      }
    });

    container.appendChild(card);
  });
}

function openReviewModalById(id) {
  const act = appState.activities.find(a => a.id === id);
  if (act) {
    openReviewModal(act);
  }
}

// ----------------------------------------------------
// STRAVA CREDENTIALS MODAL INTERFACES
// ----------------------------------------------------
function openStravaConfigModal() {
  document.getElementById('modal-strava-config').classList.add('active');
  
  // Fill current Client ID if available
  if (appState.apiConfig.strava_client_id) {
    document.getElementById('strava-client-id').value = appState.apiConfig.strava_client_id;
  }
}

function closeStravaConfigModal() {
  document.getElementById('modal-strava-config').classList.remove('active');
}

async function saveStravaCredentials(event) {
  event.preventDefault();
  
  const id = document.getElementById('strava-client-id').value.trim();
  const secret = document.getElementById('strava-client-secret').value.trim();
  
  try {
    const res = await fetch('/api/config/save', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ client_id: id, client_secret: secret })
    });
    
    if (res.ok) {
      showToast("Strava API credentials saved to SQLite securely!", "success");
      closeStravaConfigModal();
      
      // Reload configs and connection statuses
      await loadStateFromServer();
      updateDashboardUI();
    } else {
      const err = await res.json();
      showToast(`Save failed: ${err.error}`, "warning");
    }
  } catch (e) {
    showToast("Server integration offline. Credentials cannot be saved.", "warning");
  }
}

// ----------------------------------------------------
// GARMIN / STRAVA CONNECTION AUTH TRIGGERS
// ----------------------------------------------------
async function connectService(serviceName) {
  if (serviceName === 'strava') {
    if (!appState.apiConfig.strava_configured) {
      openStravaConfigModal();
      return;
    }
    if (appState.apiConfig.strava_connected) {
      triggerRealtimeStravaSync();
      return;
    }
    showToast("Redirecting to Strava Secure OAuth Portal...", "info");
    setTimeout(() => { window.location.href = "/api/connect/strava"; }, 800);
    return;
  }

  // Garmin — real credential-based flow
  if (serviceName === 'garmin') {
    if (appState.apiConfig.garmin_connected) {
      // Already connected: offer to re-sync
      triggerGarminSync();
      return;
    }
    if (appState.apiConfig.garmin_configured) {
      // Credentials already saved — kick off sync directly
      triggerGarminSync();
      return;
    }
    // Not yet configured — open credentials modal
    openGarminConfigModal();
  }
}

// Trigger Live Sync from backend
async function triggerRealtimeStravaSync() {
  const syncModal = document.getElementById('modal-service-sync');
  const title = document.getElementById('sync-loader-title');
  const subtitle = document.getElementById('sync-loader-subtitle');
  const bar = document.getElementById('sync-bar-fill');

  syncModal.classList.add('active');
  title.textContent = "Syncing Strava Real-Time Activities";
  subtitle.textContent = "Checking authorization tokens...";
  bar.style.width = "0%";

  setTimeout(() => { bar.style.width = "30%"; subtitle.textContent = "Refreshing API Access tokens..."; }, 800);
  setTimeout(() => { bar.style.width = "60%"; subtitle.textContent = "Querying Strava running activities feed..."; }, 1600);

  try {
    const res = await fetch('/api/sync/strava');
    bar.style.width = "90%";
    subtitle.textContent = "Parsing cardio telemetry and training decoupling...";
    
    if (res.ok) {
      const data = await res.json();
      setTimeout(async () => {
        bar.style.width = "100%";
        syncModal.classList.remove('active');
        
        // Reload all activities and states from server
        await loadStateFromServer();
        updateDashboardUI();
        renderWeeklyPlanCalendar();
        renderActivitiesList();
        
        showToast(`Successfully synced! Loaded ${data.synced_activities_count} runs.`, "success");
        autoOpenLatestActivityReview();
      }, 800);
    } else {
      const err = await res.json();
      syncModal.classList.remove('active');
      showToast(`Sync Failed: ${err.error}`, "warning");
    }
  } catch (e) {
    syncModal.classList.remove('active');
    showToast("Sync Request Failed: Server offline.", "warning");
  }
}

// ----------------------------------------------------
// GARMIN CONNECT CREDENTIALS MODAL
// ----------------------------------------------------
function openGarminConfigModal() {
  const modal = document.getElementById('modal-garmin-config');
  if (!modal) return;
  // Pre-fill email if known
  if (appState.apiConfig.garmin_email) {
    document.getElementById('garmin-email').value = appState.apiConfig.garmin_email;
  }
  // Show MFA notice on every open
  document.getElementById('garmin-config-notice').style.display = 'block';
  document.getElementById('garmin-save-status').style.display = 'none';
  modal.classList.add('active');
}

function closeGarminConfigModal() {
  document.getElementById('modal-garmin-config').classList.remove('active');
}

async function saveGarminCredentials(event) {
  event.preventDefault();
  const email = document.getElementById('garmin-email').value.trim();
  const password = document.getElementById('garmin-password').value.trim();

  const saveBtn = document.getElementById('garmin-save-btn');
  const statusEl = document.getElementById('garmin-save-status');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/config/garmin/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      statusEl.textContent = '✓ Credentials saved. Starting Garmin sync…';
      statusEl.style.display = 'block';
      // Reload config state
      const confRes = await fetch('/api/config');
      if (confRes.ok) appState.apiConfig = await confRes.json();
      closeGarminConfigModal();
      // Auto-trigger sync immediately
      triggerGarminSync();
    } else {
      const err = await res.json();
      showToast(`Save failed: ${err.error}`, 'warning');
    }
  } catch (e) {
    showToast('Server offline. Could not save credentials.', 'warning');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save & Sync All 2026 Activities';
  }
}

let garminSyncPoll = null;

async function triggerGarminSync() {
  const syncModal = document.getElementById('modal-service-sync');
  const title = document.getElementById('sync-loader-title');
  const subtitle = document.getElementById('sync-loader-subtitle');
  const bar = document.getElementById('sync-bar-fill');

  syncModal.classList.add('active');
  title.textContent = 'Syncing Garmin Connect';
  subtitle.textContent = 'Contacting Garmin servers…';
  bar.style.width = '0%';

  try {
    const res = await fetch('/api/sync/garmin');
    if (!res.ok) {
      const err = await res.json();
      syncModal.classList.remove('active');
      showToast(`Garmin Sync: ${err.error}`, 'warning');
      return;
    }

    // Start active status polling
    startGarminStatusPolling();
  } catch (e) {
    syncModal.classList.remove('active');
    showToast('Server offline — cannot reach Garmin sync endpoint.', 'warning');
  }
}

function startGarminStatusPolling() {
  if (garminSyncPoll) clearInterval(garminSyncPoll);
  
  const syncModal = document.getElementById('modal-service-sync');
  const title = document.getElementById('sync-loader-title');
  const subtitle = document.getElementById('sync-loader-subtitle');
  const bar = document.getElementById('sync-bar-fill');

  garminSyncPoll = setInterval(async () => {
    try {
      const res = await fetch('/api/sync/garmin/status');
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'connecting') {
        bar.style.width = '40%';
        subtitle.textContent = 'Authenticating and downloading activities…';
      } else if (data.status === 'mfa_required') {
        // Pause polling
        clearInterval(garminSyncPoll);
        garminSyncPoll = null;

        // Transition from loader to OTP input modal
        syncModal.classList.remove('active');
        document.getElementById('modal-garmin-otp').classList.add('active');
        document.getElementById('garmin-otp-input').value = '';
        document.getElementById('garmin-otp-input').focus();
        showToast('🔒 Multi-Factor Authentication Code required.', 'info');
      } else if (data.status === 'success') {
        clearInterval(garminSyncPoll);
        garminSyncPoll = null;

        bar.style.width = '100%';
        subtitle.textContent = 'Ingestion complete!';
        
        setTimeout(async () => {
          syncModal.classList.remove('active');
          await loadStateFromServer();
          updateDashboardUI();
          renderWeeklyPlanCalendar();
          renderActivitiesList();
          showToast(`✓ Garmin sync complete! Loaded ${data.synced_activities_count} activities from 2026.`, 'success');
          autoOpenLatestActivityReview();
        }, 600);
      } else if (data.status === 'failed') {
        clearInterval(garminSyncPoll);
        garminSyncPoll = null;

        syncModal.classList.remove('active');
        showToast(`Sync Failed: ${data.error || 'Unknown error occurred'}`, 'warning');
      }
    } catch (e) {
      // Gracefully ignore fetch network blips
    }
  }, 1000);
}

function closeGarminOtpModal() {
  document.getElementById('modal-garmin-otp').classList.remove('active');
}

async function submitGarminOtp(event) {
  event.preventDefault();
  const otpInput = document.getElementById('garmin-otp-input');
  const otpBtn = document.getElementById('garmin-otp-btn');
  const otp = otpInput.value.trim();

  if (!/^\d{6}$/.test(otp)) {
    showToast('Code must be a 6-digit number.', 'warning');
    return;
  }

  otpBtn.disabled = true;
  otpBtn.textContent = 'Verifying…';

  try {
    const res = await fetch('/api/sync/garmin/mfa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp: otp })
    });

    if (res.ok) {
      // Hide OTP modal
      document.getElementById('modal-garmin-otp').classList.remove('active');
      
      // Re-show loader modal and resume polling
      const syncModal = document.getElementById('modal-service-sync');
      const title = document.getElementById('sync-loader-title');
      const subtitle = document.getElementById('sync-loader-subtitle');
      const bar = document.getElementById('sync-bar-fill');
      
      syncModal.classList.add('active');
      title.textContent = 'Verifying OTP Code';
      subtitle.textContent = 'Submitting code to Garmin servers…';
      bar.style.width = '60%';
      
      startGarminStatusPolling();
    } else {
      const err = await res.json();
      showToast(`Verification failed: ${err.error}`, 'warning');
    }
  } catch (e) {
    showToast('Server offline — could not verify OTP.', 'warning');
  } finally {
    otpBtn.disabled = false;
    otpBtn.textContent = 'Verify & Continue Sync';
  }
}

// Simulator removed - strictly production data sync

// ----------------------------------------------------
// AUTOMATED RUN ANALYSIS & REVIEW MODAL
// ----------------------------------------------------
function openReviewModal(activity) {
  const modal = document.getElementById('modal-post-run-review');
  if (!modal) return;

  document.getElementById('review-modal-title').innerHTML = `Post-Run Review: <span style="color:var(--secondary)">${activity.name}</span>`;

  const totalPaceSec = (activity.duration * 60) / activity.distance;
  const paceMin = Math.floor(totalPaceSec / 60);
  const paceSec = Math.round(totalPaceSec % 60);
  const paceStr = `${paceMin}:${paceSec < 10 ? '0' + paceSec : paceSec}`;

  document.getElementById('rev-val-dist').textContent = `${activity.distance.toFixed(2)} mi`;
  document.getElementById('rev-val-pace').textContent = `${paceStr}/mi`;
  document.getElementById('rev-val-hr').textContent = `${activity.avgHeartRate} bpm`;

  const avgHR = activity.avgHeartRate;
  let z1 = 0, z2 = 0, z3 = 0, z4 = 0;
  
  if (activity.type.includes("Recovery") || avgHR < 135) {
    z1 = 45; z2 = 50; z3 = 5; z4 = 0;
  } else if (activity.type.includes("Base") || avgHR <= 145) {
    z1 = 15; z2 = 70; z3 = 12; z4 = 3;
  } else if (activity.type.includes("Long") || avgHR <= 153) {
    z1 = 10; z2 = 55; z3 = 30; z4 = 5;
  } else {
    z1 = 15; z2 = 20; z3 = 35; z4 = 30;
  }

  document.getElementById('rev-z1-pct').textContent = `${z1}%`;
  document.getElementById('rev-z1-bar').style.width = `${z1}%`;
  document.getElementById('rev-z2-pct').textContent = `${z2}%`;
  document.getElementById('rev-z2-bar').style.width = `${z2}%`;
  document.getElementById('rev-z3-pct').textContent = `${z3}%`;
  document.getElementById('rev-z3-bar').style.width = `${z3}%`;
  document.getElementById('rev-z4-pct').textContent = `${z4}%`;
  document.getElementById('rev-z4-bar').style.width = `${z4}%`;

  let decoupling = 2.4;
  let teVal = 3.2;

  if (activity.distance > 10) {
    decoupling = (avgHR > 146) ? 5.8 : 4.1;
    teVal = (avgHR > 146) ? 4.4 : 3.8;
  } else if (avgHR > 152) {
    decoupling = 3.2;
    teVal = 3.6;
  } else {
    decoupling = 1.8;
    teVal = 2.4;
  }

  const dcText = document.getElementById('rev-decoupling-val');
  dcText.textContent = `${decoupling}%`;
  if (decoupling > 5.0) {
    dcText.style.color = "var(--warning)";
  } else {
    dcText.style.color = "var(--accent)";
  }

  document.getElementById('rev-te-val').textContent = `${teVal.toFixed(1)} ${teVal >= 3.5 ? 'Improving' : 'Maintaining'}`;

  const insightEl = document.getElementById('rev-coach-insight');
  let coachReview = "";

  if (activity.type.includes("Recovery")) {
    if (avgHR < 136) {
      coachReview = `<b>Perfect Recovery Execution.</b> Your cardiovascular response was superb. Staying strictly in Zone 1/2 allows muscles to receive nutrient-rich blood flow to repair fibers without taxing your endocrine system. Exactly what we needed today. Great discipline.`;
    } else {
      coachReview = `<b>Easy Run Alert:</b> You exceeded recovery zones slightly, pushing into Zone 3. On recovery days, keep your ego fully out of the run. Running too fast on easy days blocks cellular restoration and compromises tomorrow's tempo session. Slow down next time.`;
    }
  } else if (activity.type.includes("Base")) {
    coachReview = `<b>Solid Aerobic Development.</b> This run is the core engine builder. Sticking to Zone 2 stimulates capillary density, mitochondria growth, and fatty acid oxidation. This raised your base ceiling. Decoupling was incredibly low at ${decoupling}%, indicating strong cardiovascular efficiency.`;
  } else if (activity.type.includes("Long")) {
    if (decoupling <= 5.0) {
      coachReview = `<b>Masterful Endurance pacing.</b> Keeping cardiovascular decoupling under 5% during a long run is elite. This shows that your heart rate did not drift even as leg glycogen depleted. Your metabolic efficiency is improving rapidly. You are fully prepared to absorb this peak block.`;
    } else {
      coachReview = `<b>Endurance Check:</b> Your cardiovascular decoupling drifted to ${decoupling}%. This is typical during long runs, but indicates cellular fatigue or mild dehydration in the second half. Ensure you take 150-200mg of electrolytes per hour during future long efforts.`;
    }
  } else {
    coachReview = `<b>Exceptional Lactate Threshold session!</b> You maintained high stroke volume and cleared lactate excellently in Zone 4. This raises your critical velocity. You stayed composed under load. Take a warm bath, consume high protein immediately, and prioritize 8+ hours of sleep tonight.`;
  }

  insightEl.innerHTML = coachReview;
  modal.classList.add('active');
}

function closeReviewModal() {
  document.getElementById('modal-post-run-review').classList.remove('active');
}

// ----------------------------------------------------
// TOAST NOTIFICATIONS SERVICE
// ----------------------------------------------------
function showToast(message, type = "success") {
  const container = document.getElementById('toast-container-el');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = "✓";
  if (type === "info") icon = "✦";
  if (type === "warning") icon = "⚠";
  
  toast.innerHTML = `
    <span style="font-weight: 800; font-size:1.1rem; line-height: 1;">${icon}</span>
    <div>${message}</div>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(15px)";
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 4500);
}

// ----------------------------------------------------
// DAILY COACH REVIEW MODAL & IN-DEPTH TRAINING REVIEWS
// ----------------------------------------------------
function openDailyReviewModal() {
  const modal = document.getElementById('modal-daily-review');
  if (!modal) return;

  const weekNum = appState.activeWeek;
  
  // Calculate today's day index relative to Monday (0 = Monday, 6 = Sunday)
  const jsDay = new Date().getDay();
  const targetDayMap = [6, 0, 1, 2, 3, 4, 5];
  const todayIndex = targetDayMap[jsDay];
  
  // Fetch today's schedule
  let todayWorkout = null;
  let plannedVol = 30;
  let phaseName = "Base Building Phase";
  if (appState.trainingPlan && appState.trainingPlan[weekNum - 1]) {
    const activePlanWeek = appState.trainingPlan[weekNum - 1];
    todayWorkout = activePlanWeek.schedule[todayIndex];
    plannedVol = activePlanWeek.plannedVolume;
    phaseName = activePlanWeek.phaseName;
  }

  // Get activities completed today
  const todayDateStr = new Date().toISOString().split('T')[0];
  const todayActivities = appState.activities.filter(a => a.date === todayDateStr);
  
  // Calculations
  const weeklyActual = calculateWeekActualMiles(weekNum);
  
  // Bio Readiness
  let readiness = 100;
  if (!appState.bioIndicators.sleep) readiness -= 30;
  if (!appState.bioIndicators.soreness) readiness -= 30;
  
  document.getElementById('daily-readiness-val').textContent = `${readiness}%`;
  
  // Update Plan Alignment & Status
  const planMatchEl = document.getElementById('daily-plan-match');
  const statusLblEl = document.getElementById('daily-completed-lbl');
  
  let plannedDistance = todayWorkout ? todayWorkout.distance : 0;
  let completedDistance = todayActivities
    .filter(a => a.type === 'Run' || a.type === 'Aerobic Base Run' || a.type === 'Zone 2 Recovery')
    .reduce((sum, a) => sum + a.distance, 0);
  
  planMatchEl.textContent = `${completedDistance.toFixed(1)} / ${plannedDistance.toFixed(1)} mi`;
  
  if (plannedDistance === 0) {
    statusLblEl.textContent = todayActivities.length > 0 ? "Cross-Train" : "Rest Day";
    statusLblEl.style.color = "var(--text-muted)";
  } else {
    if (completedDistance >= plannedDistance * 0.95) {
      statusLblEl.textContent = "Completed";
      statusLblEl.style.color = "var(--accent)";
    } else if (completedDistance > 0) {
      statusLblEl.textContent = "Partial";
      statusLblEl.style.color = "var(--warning)";
    } else {
      statusLblEl.textContent = "Incomplete";
      statusLblEl.style.color = "var(--danger)";
    }
  }

  // Phase & Metrics
  document.getElementById('daily-phase-lbl').textContent = phaseName;
  document.getElementById('daily-week-vol-lbl').textContent = `${weeklyActual.toFixed(1)} / ${plannedVol.toFixed(1)} miles`;
  
  let bioStatus = "Optimal";
  let bioColor = "var(--accent)";
  if (readiness === 70) {
    bioStatus = "Moderated";
    bioColor = "var(--warning)";
  } else if (readiness <= 40) {
    bioStatus = "Caution";
    bioColor = "var(--danger)";
  }
  const bioLbl = document.getElementById('daily-biometrics-lbl');
  bioLbl.textContent = bioStatus;
  bioLbl.style.color = bioColor;

  // Activities list today
  const actBox = document.getElementById('daily-activities-box');
  const actList = document.getElementById('daily-activities-list');
  actList.innerHTML = "";
  
  if (todayActivities.length > 0) {
    actBox.style.display = "block";
    todayActivities.forEach(act => {
      const row = document.createElement('div');
      row.style.display = "flex";
      row.style.justifyContent = "space-between";
      row.style.fontSize = "0.8rem";
      row.style.borderBottom = "1px solid rgba(255,255,255,0.05)";
      row.style.paddingBottom = "0.25rem";
      row.innerHTML = `
        <span style="color:#fff;">🏃 ${act.name} (${act.type})</span>
        <span style="color:var(--secondary); font-weight:600;">${act.distance.toFixed(1)} mi @ ${act.duration} mins</span>
      `;
      actList.appendChild(row);
    });
  } else {
    actBox.style.display = "none";
  }

  // Synthesize Coach Advice
  const insightEl = document.getElementById('daily-coach-insight');
  let advice = `<b>Day ${todayIndex + 1} of Week ${weekNum}: Training Phase Alignment</b><br><br>`;
  
  // Phase advice
  if (weekNum <= 4) {
    advice += `We are building your primary aerobic foundation. Sticking strictly to Zone 2 easy pacing is critical to promote capillary density and prepare your joints for future speed blocks. `;
  } else if (weekNum <= 8) {
    advice += `Lactate threshold integration block. We are elevating your aerobic ceiling by mixing tempo strides into the week. `;
  } else if (weekNum <= 12) {
    advice += `Peak Marathon training cycle. Your body is absorbing massive cumulative stress. Glycogen replenishment and soft-tissue work are your true priorities right now. `;
  } else {
    advice += `Marathon Taper block. Volume drops to supercompensate energy stores, while light active efforts keep neural pathways firing smoothly. `;
  }

  // Today workout advice
  if (todayWorkout) {
    advice += `<br><br><b>Today's Workout Plan:</b> Today was scheduled for a <b>${todayWorkout.distance > 0 ? todayWorkout.distance + 'mi ' + todayWorkout.type : 'Rest / Recovery Day'}</b>. ${todayWorkout.description}<br><br>`;
  }

  // Activity performance evaluation
  if (todayActivities.length > 0) {
    const runs = todayActivities.filter(a => a.type === 'Run' || a.type === 'Aerobic Base Run');
    if (runs.length > 0) {
      const avgHR = runs[0].avgHeartRate;
      advice += `<b>Workout Assessment:</b> You completed a run today! Avg HR was ${avgHR || '--'} bpm. `;
      if (avgHR > 150) {
        advice += `Your heart rate was slightly elevated. This suggests you might have pushed a bit hard or are carrying some residual fatigue. Slow down on your next base run! `;
      } else {
        advice += `Your heart rate stayed perfectly in control, keeping you inside the fat-oxidation recovery zone. Superb discipline! `;
      }
    } else {
      advice += `<b>Cross-Training Assessment:</b> You logged a non-running activity today (${todayActivities[0].type}). Cross-training is a spectacular way to maintain cardiorespiratory fitness while reducing vertical mechanical impact on the skeletal frame. `;
    }
  } else {
    if (plannedDistance > 0) {
      advice += `<b>Schedule Alert:</b> You missed today's planned run. Don't worry! Cumulative consistency is what builds marathon results, not any single day. Avoid double-logging tomorrow. Simply resume the plan as scheduled. `;
    } else {
      advice += `<b>Rest Day Check:</b> Rest days are where the actual physiological adaptation occurs! Sleep, nutrition, and light stretching are your primary tasks today. `;
    }
  }

  // Bio alerts
  if (readiness === 70) {
    advice += `<br><br><span style="color: var(--warning)">⚠ <b>Moderated Bio-Readiness:</b> Keep your pace 20-30 seconds slower today, and monitor muscle stiffness. Hydrate thoroughly.</span>`;
  } else if (readiness <= 40) {
    advice += `<br><br><span style="color: var(--danger)">⚠ <b>Caution - Cumulative Fatigue:</b> Bio-indicators signal high systemic stress. We highly recommend turning today into an active recovery walking session or a full rest day to prevent overuse injuries.</span>`;
  }

  insightEl.innerHTML = advice;
  modal.classList.add('active');
}

function closeDailyReviewModal() {
  document.getElementById('modal-daily-review').classList.remove('active');
}

function autoOpenLatestActivityReview() {
  if (!appState.activities || appState.activities.length === 0) return;
  // Sort activities by date descending
  const sorted = [...appState.activities].sort((a, b) => new Date(b.date) - new Date(a.date));
  const latest = sorted[0];
  
  // Only auto-open if it is a recent activity (e.g. within last 3 days)
  const actDate = new Date(latest.date);
  const diffDays = Math.abs(new Date() - actDate) / (1000 * 3600 * 24);
  if (diffDays <= 3) {
    showToast(`✦ Auto-Analyzing your latest activity: ${latest.name}`, "info");
    setTimeout(() => {
      openReviewModal(latest);
    }, 1200);
  }
}

// ----------------------------------------------------
// DYNAMIC AI WORKOUT ANALYSIS GENERATOR
// ----------------------------------------------------
function generateActivityAISummary(act) {
  const sportKey = (['Run','Ride','Swim','Walk','Strength'].find(k =>
    act.type.includes(k) || (k === 'Ride' && act.type.toLowerCase().includes('cycl'))
  )) || 'Other';

  let summary = "";
  let wentWell = [];
  let canImprove = [];

  if (sportKey === 'Run') {
    // Pace and HR calculations
    let paceMin = 8;
    let paceSec = 30;
    if (act.distance > 0 && act.duration > 0) {
      const totalPaceSec = (act.duration * 60) / act.distance;
      paceMin = Math.floor(totalPaceSec / 60);
      paceSec = Math.round(totalPaceSec % 60);
    }
    
    const avgHR = act.avgHeartRate || 140;
    
    // Decoupling estimation
    let decoupling = 2.4;
    if (act.distance > 10) {
      decoupling = (avgHR > 146) ? 5.8 : 4.1;
    } else if (avgHR > 152) {
      decoupling = 3.2;
    } else {
      decoupling = 1.8;
    }

    if (act.type.includes("Recovery") || act.type.includes("Zone 2")) {
      summary = `A highly disciplined recovery stride session designed to promote capillary density and soft-tissue flushing. You maintained a low cardiovascular footprint, which is key to cell restoration.`;
      
      if (avgHR < 136) {
        wentWell.push("Excellent heart rate control. Sticking strictly to Zone 1/2 keeps your parasympathetic nervous system responsive.");
        wentWell.push("Smooth, relaxed pace. You prioritized joint conditioning over speed.");
        canImprove.push("Include 3-4x 100m neurological strides at the end of the run to maintain muscle elasticity.");
      } else {
        wentWell.push("Completed the full scheduled recovery volume successfully.");
        canImprove.push("Your average HR suggests you drifted slightly into Zone 3. Run even slower on recovery days to bypass training fatigue.");
        canImprove.push("Ensure your recovery paces are at least 90-120 seconds slower than your target marathon pace.");
      }
    } else if (act.type.includes("Long")) {
      summary = `A stellar endurance builder, taxing your skeletal muscle glycogen stores. Sticking to target pacing during fatigue develops deep metabolic efficiency.`;
      
      wentWell.push(`Superb pacing consistency. You managed leg fatigue well in the second half of the run.`);
      
      if (decoupling <= 5.0) {
        wentWell.push(`Cardiac drift stayed under control at ${decoupling}%, showing high stroke volume retention and elite aerobic conditioning.`);
        canImprove.push("Focus on carbohydrate-loading details 36 hours before your next peak block long run.");
      } else {
        canImprove.push(`Cardiovascular decoupling drifted to ${decoupling}%. This suggests glycogen depletion or mild dehydration in the final miles.`);
        canImprove.push("Ensure you consume 150-200mg of sodium electrolytes and 40g of simple carbs per hour during runs over 90 mins.");
      }
    } else if (act.type.includes("Tempo") || act.type.includes("Interval") || avgHR > 150) {
      summary = `A powerful neuro-muscular velocity session elevating your lactate threshold limit. You sustained high cardiac output and cleared lactate efficiently.`;
      
      wentWell.push("Sustained threshold efforts excellent. You raised your aerobic base ceiling.");
      wentWell.push("Maintained high muscular cadence under cardiovascular stress.");
      canImprove.push("Ensure you ingest a high-protein shake and active carbs within 30 minutes post-run for rapid muscle fiber repair.");
      canImprove.push("Prioritize a warm bath, foam rolling, and 8+ hours of sleep tonight to absorb this heavy training stress.");
    } else {
      summary = `A solid cardiovascular base development run. Sticking to Zone 2 easy pacing stimulates mitochondrial growth and fat oxidation.`;
      wentWell.push("Excellent base pacing. You accumulated valuable aerobic volume.");
      wentWell.push(`Cardiovascular decoupling stayed healthy at ${decoupling}%, indicating robust stroke volume stability.`);
      canImprove.push("Keep easy days easy. Focus on deep diaphragmatic breathing to stabilize heart rate further.");
    }
  } else if (sportKey === 'Ride') {
    summary = `Spectacular non-impact cross-training! Cycling allows you to load your cardiorespiratory system and flush out leg lactic acid without mechanical impact forces.`;
    wentWell.push("Zero joint stress. You built aerobic base fitness while protecting knee/ankle ligaments.");
    wentWell.push("Excellent active recovery session flushing metabolic waste from your quad fibers.");
    canImprove.push("Keep the cadence high (85-95 RPM) to focus the training effect on your heart rather than overloading leg muscles.");
  } else if (sportKey === 'Swim') {
    summary = `Superb upper-body base training. Swimming provides massive horizontal cardiovascular load, improves lung capacity, and decompresses the spine.`;
    wentWell.push("Fully decompressed posture. Highly effective active recovery for your lower limbs.");
    wentWell.push("Excellent core activation and diaphragmatic breathing training.");
    canImprove.push("Focus on ankle flexibility and smooth stroke technique to maximize horizontal water glide.");
  } else if (sportKey === 'Strength') {
    summary = `A fundamental core stability session. Strengthening your glutes, hamstrings, and trunk prevents posture collapse and injuries during late-stage marathon miles.`;
    wentWell.push("Direct focus on running-specific muscular strength and single-leg stability.");
    wentWell.push("Activated glutes and core, protecting your lower back from heavy mechanical landing forces.");
    canImprove.push("Focus on eccentric control (slow lowering phase) to build durable eccentric muscle fibers needed for long downhills.");
  } else {
    summary = `A useful cross-training workout contributing to your weekly physical activity base and active restoration.`;
    wentWell.push("Maintained dynamic consistency and checked off valuable recovery time.");
    canImprove.push("Ensure your active recovery efforts do not interfere with high-priority running training days.");
  }

  return { summary, wentWell, canImprove };
}

function renderYtdStats() {
  const countEl = document.getElementById('ytd-total-count');
  if (!countEl) return;

  const acts = appState.activities || [];
  
  // 1. Total Workouts
  countEl.textContent = acts.length;

  // 2. Classify sports
  let runCount = 0, runDist = 0;
  let rideCount = 0, rideDist = 0;
  let swimCount = 0, swimDist = 0;
  let strengthCount = 0, strengthDur = 0;
  let walkCount = 0, walkDist = 0;

  acts.forEach(act => {
    const sportKey = (['Run','Ride','Swim','Walk','Strength'].find(k =>
      act.type.includes(k) || (k === 'Ride' && act.type.toLowerCase().includes('cycl'))
    )) || 'Other';

    if (sportKey === 'Run') {
      runCount++;
      runDist += act.distance;
    } else if (sportKey === 'Ride') {
      rideCount++;
      rideDist += act.distance;
    } else if (sportKey === 'Swim') {
      swimCount++;
      swimDist += act.distance;
    } else if (sportKey === 'Strength') {
      strengthCount++;
      strengthDur += act.duration;
    } else if (sportKey === 'Walk') {
      walkCount++;
      walkDist += act.distance;
    } else {
      // Map other cross-training into active walking or strength based on distance
      if (act.distance > 0) {
        walkCount++;
        walkDist += act.distance;
      } else {
        strengthCount++;
        strengthDur += act.duration;
      }
    }
  });

  // 3. Update Meta Text Labels
  document.getElementById('ytd-run-meta').innerHTML = `${runCount} runs &bull; ${runDist.toFixed(1)} mi`;
  document.getElementById('ytd-ride-meta').innerHTML = `${rideCount} rides &bull; ${rideDist.toFixed(1)} mi`;
  document.getElementById('ytd-swim-meta').innerHTML = `${swimCount} swims &bull; ${swimDist.toFixed(1)} mi`;
  document.getElementById('ytd-strength-meta').innerHTML = `${strengthCount} sessions &bull; ${strengthDur} mins`;
  document.getElementById('ytd-walk-meta').innerHTML = `${walkCount} walks &bull; ${walkDist.toFixed(1)} mi`;

  // 4. Update progress bars (scale bars relative to maximum count of any sport)
  const maxVal = Math.max(runCount, rideCount, swimCount, strengthCount, walkCount, 1);
  document.getElementById('ytd-run-bar').style.width = `${Math.round((runCount / maxVal) * 100)}%`;
  document.getElementById('ytd-ride-bar').style.width = `${Math.round((rideCount / maxVal) * 100)}%`;
  document.getElementById('ytd-swim-bar').style.width = `${Math.round((swimCount / maxVal) * 100)}%`;
  document.getElementById('ytd-strength-bar').style.width = `${Math.round((strengthCount / maxVal) * 100)}%`;
  document.getElementById('ytd-walk-bar').style.width = `${Math.round((walkCount / maxVal) * 100)}%`;
}

// ----------------------------------------------------
// PILLAR 1: ATHLETE INTELLIGENCE 30-DAY TRENDS
// ----------------------------------------------------
function renderAthleteIntelligenceTrends() {
  const strainValEl = document.getElementById('trends-strain-val');
  const strainStatusEl = document.getElementById('trends-strain-status');
  const zonesMetaEl = document.getElementById('trends-zones-meta');
  const insightsContainer = document.getElementById('trends-insights-container');
  const barZ1 = document.getElementById('trends-bar-z1');
  const barZ2 = document.getElementById('trends-bar-z2');
  const barZ3 = document.getElementById('trends-bar-z3');

  if (!strainValEl || !insightsContainer) return;

  const acts = appState.activities || [];
  if (acts.length === 0) {
    strainValEl.textContent = "0";
    strainStatusEl.textContent = "Inactive";
    zonesMetaEl.textContent = "0% Aerobic";
    if (barZ1) barZ1.style.width = "0%";
    if (barZ2) barZ2.style.width = "0%";
    if (barZ3) barZ3.style.width = "0%";
    insightsContainer.innerHTML = `<li>✦ No activities logged. Connect your Garmin profile to sync and calculate trends!</li>`;
    return;
  }

  // 1. Calculate 30-day window
  const today = new Date();
  const cutoff = new Date();
  cutoff.setDate(today.getDate() - 30);

  const last30Acts = acts.filter(a => {
    const d = new Date(a.date);
    return d >= cutoff && d <= today;
  });

  if (last30Acts.length === 0) {
    strainValEl.textContent = "0";
    strainStatusEl.textContent = "Rest / Recovery";
    zonesMetaEl.textContent = "No data";
    if (barZ1) barZ1.style.width = "0%";
    if (barZ2) barZ2.style.width = "0%";
    if (barZ3) barZ3.style.width = "0%";
    insightsContainer.innerHTML = `<li>✦ No workouts in the last 30 days. Maintain consistency to build momentum!</li>`;
    return;
  }

  // 2. Exertion Strain Index
  let strainSum = 0;
  let runningActsCount = 0;
  let durZ1 = 0, durZ2 = 0, durZ3 = 0;
  let totalHrVal = 0, totalHrCount = 0;
  let avgPaceSecSum = 0, avgPaceCount = 0;

  last30Acts.forEach(act => {
    const isRun = act.type === 'Run' || act.type === 'Aerobic Base Run' || act.type === 'Zone 2 Recovery' || act.type.toLowerCase().includes('run');
    
    // Accumulate strain for cardiovascular/distance work
    if (act.duration > 0 && (isRun || act.type === 'Ride' || act.type === 'Swim')) {
      const hr = act.avgHeartRate || 140;
      strainSum += (act.duration * hr) / 100;
    }

    if (isRun) {
      runningActsCount++;
      if (act.avgHeartRate > 0) {
        totalHrVal += act.avgHeartRate;
        totalHrCount++;
      }
      if (act.distance > 0 && act.duration > 0) {
        const paceSec = (act.duration * 60) / act.distance;
        avgPaceSecSum += paceSec;
        avgPaceCount++;
      }
    }

    // Zone categorization
    if (act.avgHeartRate > 0) {
      const hr = act.avgHeartRate;
      const dur = act.duration || 0;
      if (hr < 135) durZ1 += dur;
      else if (hr <= 150) durZ2 += dur;
      else durZ3 += dur;
    }
  });

  strainSum = Math.round(strainSum);
  strainValEl.textContent = strainSum;

  // Training Status text
  let status = "Inactive";
  let statusColor = "var(--text-muted)";
  if (strainSum === 0) {
    status = "Inactive";
  } else if (strainSum < 100) {
    status = "Detraining";
    statusColor = "var(--danger)";
  } else if (strainSum < 250) {
    status = "Recovery Base";
    statusColor = "var(--accent)";
  } else if (strainSum < 550) {
    status = "Productive (Optimal)";
    statusColor = "var(--secondary)";
  } else {
    status = "Overreaching (High Load)";
    statusColor = "var(--warning)";
  }
  strainStatusEl.textContent = status;
  strainStatusEl.style.color = statusColor;

  // 3. HR zones rendering
  const totalZoneDur = durZ1 + durZ2 + durZ3 || 1;
  const pZ1 = Math.round((durZ1 / totalZoneDur) * 100);
  const pZ2 = Math.round((durZ2 / totalZoneDur) * 100);
  const pZ3 = 100 - pZ1 - pZ2;

  if (barZ1) barZ1.style.width = `${pZ1}%`;
  if (barZ2) barZ2.style.width = `${pZ2}%`;
  if (barZ3) barZ3.style.width = `${pZ3}%`;

  zonesMetaEl.textContent = `${pZ2}% Aerobic Focus`;

  // 4. Generate dynamic AI Trend Insights
  const insights = [];

  // Insight A: Consistency
  const targetCompleted = last30Acts.length;
  insights.push(`Consistency: You logged <b>${targetCompleted} active sessions</b> in the last 30 days, successfully building cellular endurance.`);

  // Insight B: Zone distribution check
  if (pZ2 >= 60) {
    insights.push(`Aerobic Base: Outstanding! <b>${pZ2}% of exertion</b> is focused in Zone 2, expanding capillary networks and glycogen storage.`);
  } else if (pZ3 > 35) {
    insights.push(`Intensity Check: <b>${pZ3}% of work</b> is in Zone 3 (high intensity). Focus on easing your paces to avoid metabolic exhaustion.`);
  } else {
    insights.push(`Mitochondrial base: Good balance. ${pZ1}% recovery, ${pZ2}% aerobic. This supports optimal cardiorespiratory adaptation.`);
  }

  // Insight C: Pace & Cardiovascular drift
  if (avgPaceCount > 0 && totalHrCount > 0) {
    const avgPaceSec = avgPaceSecSum / avgPaceCount;
    const avgMin = Math.floor(avgPaceSec / 60);
    const avgSec = Math.round(avgPaceSec % 60);
    const avgHr = Math.round(totalHrVal / totalHrCount);
    insights.push(`Drift Efficiency: Running average pace is <b>${avgMin}:${avgSec < 10 ? '0' + avgSec : avgSec}/mi</b> at a stable cardiac cost of <b>${avgHr} bpm</b>.`);
  }

  insightsContainer.innerHTML = insights.map(ins => `<li>✦ ${ins}</li>`).join('');
}

// ----------------------------------------------------
// PILLAR 2: INLINE INTERACTIVE ACTIVITY CHAT
// ----------------------------------------------------
function toggleInlineChat(activityId) {
  const container = document.getElementById(`chat-container-${activityId}`);
  if (!container) return;

  const isHidden = container.style.display === 'none';
  // Collapse all other chats first
  document.querySelectorAll('.activity-chat-container').forEach(c => c.style.display = 'none');

  if (isHidden) {
    container.style.display = 'flex';
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const input = document.getElementById(`chat-input-${activityId}`);
    if (input) input.focus();
  } else {
    container.style.display = 'none';
  }
}

function clickInlinePromptChip(chipEl, text, activityId) {
  const input = document.getElementById(`chat-input-${activityId}`);
  if (!input) return;
  input.value = text;
  // Trigger form submit
  const form = input.closest('form');
  if (form) {
    const e = new Event('submit', { cancelable: true });
    form.dispatchEvent(e);
  }
}

function submitInlineChatMessage(event, activityId) {
  event.preventDefault();
  const input = document.getElementById(`chat-input-${activityId}`);
  const log = document.getElementById(`chat-log-${activityId}`);
  if (!input || !log) return;

  const userText = input.value.trim();
  if (!userText) return;

  input.value = "";

  // Append user message
  const userRow = document.createElement('div');
  userRow.className = "chat-msg-row user";
  userRow.innerHTML = `<div class="chat-msg-bubble">${userText}</div>`;
  log.appendChild(userRow);
  log.scrollTop = log.scrollHeight;

  // Append coach typing indicator
  const typingRow = document.createElement('div');
  typingRow.className = "chat-msg-row coach";
  typingRow.innerHTML = `<div class="chat-msg-bubble" id="typing-${activityId}">Coach Aero is writing...</div>`;
  log.appendChild(typingRow);
  log.scrollTop = log.scrollHeight;

  const act = appState.activities.find(a => a.id === activityId) || { name: 'run', distance: 5.0, duration: 42, avgHeartRate: 138, type: 'Run' };

  setTimeout(() => {
    // Generate sports-science response
    let responseText = "";
    const query = userText.toLowerCase();

    if (query.includes('drift') || query.includes('cardio') || query.includes('heart') || query.includes('decoupling') || query.includes('zone')) {
      responseText = `I've analyzed your cardiovascular metrics for this run (${act.distance.toFixed(1)} miles). Since your average heart rate was **${act.avgHeartRate || 140} bpm**, you spent your time well inside your aerobic base limits. To prevent heart rate drift (cardiac creep) in the second half of your long runs, ensure you drink 6-8oz of electrolytes every 20 minutes, even if you do not feel thirsty!`;
    } else if (query.includes('recovery') || query.includes('stretch') || query.includes('sore') || query.includes('calf') || query.includes('ache') || query.includes('tight')) {
      responseText = `AeroStride Recovery Protocol: After a ${act.distance.toFixed(1)}-mile effort, your muscle fibers have high acidity. Focus on: (1) 3 minutes of dynamic calf calf-raises to push pooled blood out of leg tissues, (2) 10 deep single-leg glute bridges to realign pelvis posture, and (3) taking 500mg of magnesium with 20oz of water. Avoid deep static hamstring stretches immediately after long runs when fibers are micro-torn!`;
    } else if (query.includes('next') || query.includes('focus') || query.includes('session') || query.includes('plan')) {
      responseText = `Looking ahead in your training! Your next key running session should be kept strictly in **Zone 2 Aerobic Base** intensity (under 145 bpm). Focus on landing with a soft bent knee directly under your hips, keeping your cadence between 172-180 steps per minute. Building capillary density at slow paces is the single most critical step to locking in a sub 3:30:00 marathon.`;
    } else {
      responseText = `Superb job completing this **${act.type}**! Running **${act.distance.toFixed(1)} miles** in **${act.duration} minutes** adds a solid brick to your marathon stamina blocks. To optimize your recovery, foam roll your quad muscles, drink plenty of water, and ensure you sleep >7.5 hours tonight to trigger natural human growth hormone release.`;
    }

    // Remove typing bubble
    const typingBubble = document.getElementById(`typing-${activityId}`);
    if (typingBubble) {
      const parentRow = typingBubble.closest('.chat-msg-row');
      if (parentRow) parentRow.remove();
    }

    // Append actual coach bubble with typewriter effect
    const coachRow = document.createElement('div');
    coachRow.className = "chat-msg-row coach";
    const bubble = document.createElement('div');
    bubble.className = "chat-msg-bubble";
    coachRow.appendChild(bubble);
    log.appendChild(coachRow);

    let charIdx = 0;
    function typeEffect() {
      if (charIdx < responseText.length) {
        // Handle bold markdown conversion locally in print
        const partial = responseText.substring(0, charIdx + 1);
        bubble.innerHTML = partial.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        charIdx += 2; // Type faster
        log.scrollTop = log.scrollHeight;
        setTimeout(typeEffect, 15);
      } else {
        bubble.innerHTML = responseText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        log.scrollTop = log.scrollHeight;
      }
    }
    typeEffect();
  }, 1200);
}

// ----------------------------------------------------
// PILLAR 3: AI TRAINING PLAN RECALIBRATOR
// ----------------------------------------------------
function openRecalibrateModal() {
  const modal = document.getElementById('modal-recalibrate-plan');
  if (!modal) return;

  const planRunsCount = countPlanTotalRuns();
  const completedRunsCount = Object.keys(appState.completedWorkouts).length;
  const consistencyPct = planRunsCount > 0 ? Math.round((completedRunsCount / planRunsCount) * 100) : 0;

  document.getElementById('recal-compliance-val').textContent = `${consistencyPct}%`;

  const isSore = appState.bioIndicators.soreness;
  const fatigueVal = document.getElementById('recal-fatigue-val');
  if (isSore) {
    fatigueVal.textContent = "Sore / Stiff";
    fatigueVal.style.color = "var(--warning)";
  } else {
    fatigueVal.textContent = "Optimal";
    fatigueVal.style.color = "var(--accent)";
  }

  const paceStats = calculateAveragePace();
  document.getElementById('recal-pace-deviation').textContent = paceStats.paceStr !== "0:00" ? `${paceStats.paceStr}/mi` : "Base Base";

  modal.classList.add('active');
}

function closeRecalibrateModal() {
  const modal = document.getElementById('modal-recalibrate-plan');
  if (modal) modal.classList.remove('active');
}

async function applyPlanRecalibration(event) {
  event.preventDefault();
  if (!appState.trainingPlan) return;

  const form = document.getElementById('recalibrate-plan-form');
  const strategy = form.elements['recal-strategy'].value;

  const currentWeek = appState.activeWeek;

  // Modify remaining plan weeks dynamically
  appState.trainingPlan.forEach(week => {
    if (week.weekNum >= currentWeek) {
      if (strategy === 'taper') {
        // Decrease volume by 15%
        week.plannedVolume = Math.round(week.plannedVolume * 0.85);
        week.schedule.forEach(day => {
          if (day.distance > 0) {
            day.distance = Math.round(day.distance * 0.85 * 10) / 10;
            // Shift high intensity to zone 2 recovery
            if (day.type.includes("Tempo") || day.type.includes("Interval")) {
              day.type = "Zone 2 Recovery";
              day.description = "Converted intervals to dynamic cardiovascular flushing to clear lactic acid and build capillary beds safely.";
            }
          }
        });
      } else if (strategy === 'accelerate') {
        // Increase volume by 10%
        week.plannedVolume = Math.round(week.plannedVolume * 1.10);
        week.schedule.forEach(day => {
          if (day.distance > 0) {
            day.distance = Math.round(day.distance * 1.10 * 10) / 10;
            day.description += " [AI Accelerated Pace Stride]";
          }
        });
      } else if (strategy === 'reperiodize') {
        // Gently adjust volume by spreading load
        week.plannedVolume = Math.round(week.plannedVolume * 0.95);
        week.schedule.forEach(day => {
          if (day.distance > 0) {
            day.distance = Math.round(day.distance * 0.95 * 10) / 10;
          }
        });
      }
    }
  });

  // Save the recalibrated plan back to SQLite server
  try {
    const response = await fetch('/api/profile/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trainingPlan: appState.trainingPlan })
    });
    
    if (response.ok) {
      showToast(`✓ Dynamic Recalibration applied: ${strategy === 'taper' ? 'Bio-Adaptive Taper' : strategy === 'accelerate' ? 'Peak Acceleration' : 'Conservative Periodize'}!`, "success");
    } else {
      showToast("Could not save recalibrated plan to server.", "warning");
    }
  } catch (err) {
    showToast("Server connection error during recalibration.", "warning");
  }

  closeRecalibrateModal();
  updateDashboardUI();
  renderWeeklyPlanCalendar();
}
