/**
 * BiteTrack — script.js
 *
 * Motion-based bite detection using the DeviceMotion API.
 * Post-meal: renders three Chart.js charts in the summary card.
 *
 * Sections:
 *   1. CONFIG
 *   2. State
 *   3. DOM refs
 *   4. Motion permission & setup
 *   5. DeviceMotion handler
 *   6. Bite detection state machine
 *   7. Meal controls (start / end / reset)
 *   8. Live stats refresh
 *   9. Timeline
 *  10. Post-meal summary + charts
 *  11. Survey submission
 *  12. Utilities
 *  13. Event listeners
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. CONFIG
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  BITE_THRESHOLD:       40,    // deg/s — rotation magnitude to start a bite
  BITE_MIN_DURATION_MS: 150,   // ms — minimum burst to count as a bite
  BITE_MAX_DURATION_MS: 2000,  // ms — cap to filter sustained non-bite motion
  COOLDOWN_MS:          400,   // ms — dead zone after each bite
  STATS_REFRESH_MS:     500,   // ms — live stats update interval
  MOTION_BAR_MAX:       200,   // deg/s — full-scale value for motion bar
  SUBMIT_URL: 'https://script.google.com/macros/s/AKfycbwyzboILipQTfWY4DMGVDLr1qeG_-nG_sxpmFTFhAFcts3qHzI8rIf1bEbpB5FZfe0DZQ/exec',
};

// ─────────────────────────────────────────────────────────────
// 2. STATE
// ─────────────────────────────────────────────────────────────
const state = {
  motionEnabled:    false,
  currentMagnitude: 0,
  mealActive:       false,
  mealStartTime:    null,
  mealEndTime:      null,
  aboveThreshold:   false,
  biteStartTime:    null,
  lastBiteEndTime:  0,
  bites:            [],   // { start, end, duration }
  statsTimer:       null,
  charts:           { durations: null, pace: null, gaps: null },
};

// ─────────────────────────────────────────────────────────────
// 3. DOM REFS
// ─────────────────────────────────────────────────────────────
const ui = {
  btnEnable:        document.getElementById('btnEnable'),
  btnStart:         document.getElementById('btnStart'),
  btnEnd:           document.getElementById('btnEnd'),
  btnReset:         document.getElementById('btnReset'),
  sensorStatusText: document.getElementById('sensorStatusText'),
  statusBadge:      document.getElementById('statusBadge'),
  statMealTime:     document.getElementById('statMealTime'),
  statBites:        document.getElementById('statBites'),
  statAvgDuration:  document.getElementById('statAvgDuration'),
  statPace:         document.getElementById('statPace'),
  motionBar:        document.getElementById('motionBar'),
  motionValue:      document.getElementById('motionValue'),
  thresholdMarker:  document.getElementById('thresholdMarker'),
  biteIndicator:    document.getElementById('biteIndicator'),
  timelineTrack:    document.getElementById('timelineTrack'),
  timelineEnd:      document.getElementById('timelineEnd'),
  summaryCard:      document.getElementById('summaryCard'),
  sumMealTime:      document.getElementById('sumMealTime'),
  sumBites:         document.getElementById('sumBites'),
  sumAvg:           document.getElementById('sumAvg'),
  sumPace:          document.getElementById('sumPace'),
  surveyCard:       document.getElementById('surveyCard'),
  surveyForm:       document.getElementById('surveyForm'),
  btnSubmit:        document.getElementById('btnSubmit'),
  submitStatus:     document.getElementById('submitStatus'),
  fieldName:        document.getElementById('fieldName'),
  fieldContext:     document.getElementById('fieldContext'),
  fieldStress:      document.getElementById('fieldStress'),
  fieldDistraction: document.getElementById('fieldDistraction'),
  fieldNotes:       document.getElementById('fieldNotes'),
};

// ─────────────────────────────────────────────────────────────
// 4. MOTION PERMISSION & SETUP
// ─────────────────────────────────────────────────────────────

// Position the threshold marker on the motion bar
(function positionThresholdMarker() {
  const pct = (CONFIG.BITE_THRESHOLD / CONFIG.MOTION_BAR_MAX) * 100;
  ui.thresholdMarker.style.left = Math.min(pct, 100) + '%';
})();

async function enableMotion() {
  // iOS 13+ requires explicit permission
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      result === 'granted' ? attachMotionListener() : setSensorStatus('Permission denied', false);
    } catch (e) {
      setSensorStatus('Error: ' + e.message, false);
    }
  } else if (typeof DeviceMotionEvent !== 'undefined') {
    attachMotionListener(); // Android / desktop — no prompt needed
  } else {
    setSensorStatus('DeviceMotion not supported', false);
  }
}

function attachMotionListener() {
  window.addEventListener('devicemotion', onDeviceMotion);
  state.motionEnabled = true;
  setSensorStatus('Active ✓', true);
  ui.btnStart.disabled = false;
  setStatusBadge('ready');
}

function setSensorStatus(text, ok) {
  ui.sensorStatusText.textContent = text;
  ui.sensorStatusText.style.color = ok ? 'var(--success)' : 'var(--danger)';
}

// ─────────────────────────────────────────────────────────────
// 5. DEVICEMOTION HANDLER
// ─────────────────────────────────────────────────────────────

function onDeviceMotion(event) {
  const rr = event.rotationRate;
  if (!rr) return;

  // Euclidean magnitude of all three rotation axes (deg/s)
  const magnitude = Math.sqrt(
    (rr.alpha || 0) ** 2 +
    (rr.beta  || 0) ** 2 +
    (rr.gamma || 0) ** 2
  );

  state.currentMagnitude = magnitude;
  updateMotionBar(magnitude);

  if (state.mealActive) detectBite(magnitude);
}

// ─────────────────────────────────────────────────────────────
// 6. BITE DETECTION STATE MACHINE
// ─────────────────────────────────────────────────────────────

/**
 * Two-state machine:
 *   IDLE   → magnitude ≥ THRESHOLD (and not in cooldown) → ACTIVE
 *   ACTIVE → magnitude drops below THRESHOLD → validate duration → record or discard
 */
function detectBite(magnitude) {
  const now        = Date.now();
  const inCooldown = (now - state.lastBiteEndTime) < CONFIG.COOLDOWN_MS;

  if (!state.aboveThreshold) {
    if (magnitude >= CONFIG.BITE_THRESHOLD && !inCooldown) {
      state.aboveThreshold = true;
      state.biteStartTime  = now;
    }
  } else {
    if (magnitude < CONFIG.BITE_THRESHOLD) {
      state.aboveThreshold = false;
      const duration = now - state.biteStartTime;

      if (duration >= CONFIG.BITE_MIN_DURATION_MS && duration <= CONFIG.BITE_MAX_DURATION_MS) {
        recordBite(state.biteStartTime, now, duration);
      }

      state.lastBiteEndTime = now;
      state.biteStartTime   = null;
    }
  }
}

function recordBite(start, end, duration) {
  state.bites.push({ start, end, duration });
  flashBiteIndicator();
  addTimelineTick(start);
}

// ─────────────────────────────────────────────────────────────
// 7. MEAL CONTROLS
// ─────────────────────────────────────────────────────────────

function startMeal() {
  if (!state.motionEnabled) return;
  Object.assign(state, {
    mealActive: true,
    mealStartTime: Date.now(),
    mealEndTime: null,
    bites: [],
    aboveThreshold: false,
    biteStartTime: null,
    lastBiteEndTime: 0,
  });

  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(t => t.remove());
  ui.timelineEnd.textContent = '—';
  ui.btnStart.disabled = true;
  ui.btnEnd.disabled   = false;
  ui.btnReset.disabled = true;
  setStatusBadge('eating');
  state.statsTimer = setInterval(refreshStats, CONFIG.STATS_REFRESH_MS);
}

function endMeal() {
  state.mealActive  = false;
  state.mealEndTime = Date.now();

  clearInterval(state.statsTimer);
  refreshStats();

  ui.btnEnd.disabled   = true;
  ui.btnStart.disabled = true;
  ui.btnReset.disabled = false;
  setStatusBadge('done');

  ui.timelineEnd.textContent = formatDuration(state.mealEndTime - state.mealStartTime);
  rescaleTimeline();

  renderSummary();

  ui.summaryCard.hidden = false;
  ui.surveyCard.hidden  = false;

  setTimeout(() => ui.summaryCard.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
}

function resetAll() {
  clearInterval(state.statsTimer);
  Object.assign(state, {
    mealActive: false, mealStartTime: null, mealEndTime: null,
    bites: [], aboveThreshold: false, biteStartTime: null, lastBiteEndTime: 0,
  });

  ['durations', 'pace', 'gaps'].forEach(k => {
    if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
  });

  ui.statMealTime.textContent    = '0:00';
  ui.statBites.textContent       = '0';
  ui.statAvgDuration.textContent = '0.0s';
  ui.statPace.textContent        = '0.0';
  ui.motionBar.style.width       = '0%';
  ui.motionValue.textContent     = '0.0';
  ui.biteIndicator.classList.remove('visible');
  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(t => t.remove());
  ui.timelineEnd.textContent   = '—';
  ui.summaryCard.hidden        = true;
  ui.surveyCard.hidden         = true;
  ui.surveyForm.reset();
  ui.submitStatus.hidden       = true;
  ui.btnSubmit.disabled        = false;
  ui.btnSubmit.textContent     = 'Submit';
  ui.btnStart.disabled         = !state.motionEnabled;
  ui.btnEnd.disabled           = true;
  setStatusBadge(state.motionEnabled ? 'ready' : 'idle');
}

// ─────────────────────────────────────────────────────────────
// 8. LIVE STATS REFRESH
// ─────────────────────────────────────────────────────────────

function refreshStats() {
  const now     = state.mealActive ? Date.now() : (state.mealEndTime || Date.now());
  const elapsed = state.mealStartTime ? now - state.mealStartTime : 0;
  const count   = state.bites.length;

  ui.statMealTime.textContent = formatDuration(elapsed);
  ui.statBites.textContent    = count;

  const avg = count > 0 ? state.bites.reduce((s, b) => s + b.duration, 0) / count : 0;
  ui.statAvgDuration.textContent = (avg / 1000).toFixed(1) + 's';

  const pace = elapsed > 0 && count > 0 ? count / (elapsed / 60000) : 0;
  ui.statPace.textContent = pace.toFixed(1);
}

// ─────────────────────────────────────────────────────────────
// 9. TIMELINE
// ─────────────────────────────────────────────────────────────

function addTimelineTick(biteStart) {
  if (!state.mealStartTime) return;
  const elapsed   = Date.now() - state.mealStartTime;
  if (elapsed <= 0) return;
  const relMs = biteStart - state.mealStartTime;
  const pct   = Math.max(0, Math.min((relMs / elapsed) * 100, 100));

  const tick = document.createElement('div');
  tick.className       = 'timeline-tick';
  tick.style.left      = pct + '%';
  tick.dataset.biteMs  = relMs;
  ui.timelineTrack.appendChild(tick);
}

function rescaleTimeline() {
  const totalMs = state.mealEndTime - state.mealStartTime;
  if (totalMs <= 0) return;
  ui.timelineTrack.querySelectorAll('.timeline-tick').forEach(tick => {
    const pct = Math.max(0, Math.min((parseFloat(tick.dataset.biteMs) / totalMs) * 100, 100));
    tick.style.left = pct + '%';
  });
}

// ─────────────────────────────────────────────────────────────
// 10. POST-MEAL SUMMARY + CHARTS
// ─────────────────────────────────────────────────────────────

/** Shared typography/color defaults for all Chart.js instances */
function cd() {
  return { color: '#6b6460', font: { family: "'DM Mono', monospace", size: 11 } };
}

function renderSummary() {
  const { bites, mealStartTime, mealEndTime } = state;
  const mealMs    = mealEndTime - mealStartTime;
  const count     = bites.length;
  const avgMs     = count > 0 ? bites.reduce((s, b) => s + b.duration, 0) / count : 0;
  const pace      = count > 0 && mealMs > 0 ? count / (mealMs / 60000) : 0;

  // Hero numbers
  ui.sumMealTime.textContent = formatDuration(mealMs);
  ui.sumBites.textContent    = count;
  ui.sumAvg.textContent      = (avgMs / 1000).toFixed(1) + 's';
  ui.sumPace.textContent     = pace.toFixed(1);

  if (count === 0) {
    ['chartBiteDurations', 'chartPace', 'chartGaps'].forEach(id => {
      const cvs = document.getElementById(id);
      const ctx = cvs.getContext('2d');
      cvs.height = 80;
      ctx.fillStyle = '#aaa';
      ctx.font = '12px DM Mono, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No bites recorded', cvs.clientWidth / 2, 40);
    });
    return;
  }

  // ── Chart 1: Bite duration bar chart ──────────────────
  const durData   = bites.map(b => +(b.duration / 1000).toFixed(2));
  const durLabels = bites.map((_, i) => `#${i + 1}`);
  const avgSec    = +(avgMs / 1000).toFixed(2);

  if (state.charts.durations) state.charts.durations.destroy();
  state.charts.durations = new Chart(document.getElementById('chartBiteDurations'), {
    type: 'bar',
    data: {
      labels: durLabels,
      datasets: [
        {
          label: 'Duration (s)',
          data: durData,
          backgroundColor: durData.map(d =>
            d > avgSec ? 'rgba(212,119,10,0.85)' : 'rgba(212,119,10,0.35)'
          ),
          borderColor: 'rgba(212,119,10,1)',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          type: 'line',
          label: 'Average',
          data: durData.map(() => avgSec),
          borderColor: '#c0392b',
          borderDash: [5, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { ...cd(), boxWidth: 12 } },
        tooltip: { callbacks: { label: c => ` ${c.parsed.y}s` } },
      },
      scales: {
        x: { ticks: { ...cd(), maxRotation: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
      },
    },
  });

  // ── Chart 2: Rolling pace (line) ───────────────────────
  // Split meal into 10-second buckets; convert count → bites/min
  const BUCKET = 10000;
  const buckets = Math.max(1, Math.ceil(mealMs / BUCKET));
  const counts  = new Array(buckets).fill(0);
  bites.forEach(b => {
    const idx = Math.min(Math.floor((b.start - mealStartTime) / BUCKET), buckets - 1);
    counts[idx]++;
  });
  const paceData = counts.map(c => +(c * 6).toFixed(1)); // ×6 = per minute
  // 3-point smoothing
  const smooth = paceData.map((v, i, a) => {
    const s = a.slice(Math.max(0, i - 1), i + 2);
    return +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1);
  });
  const paceLabels = counts.map((_, i) => formatDuration(i * BUCKET));

  if (state.charts.pace) state.charts.pace.destroy();
  state.charts.pace = new Chart(document.getElementById('chartPace'), {
    type: 'line',
    data: {
      labels: paceLabels,
      datasets: [{
        label: 'Bites / min',
        data: smooth,
        borderColor: '#2e7d4f',
        backgroundColor: 'rgba(46,125,79,0.08)',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: '#2e7d4f',
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { ...cd(), boxWidth: 12 } },
        tooltip: { callbacks: { label: c => ` ${c.parsed.y} bites/min` } },
      },
      scales: {
        x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } },
        y: { ticks: { ...cd(), callback: v => v + '/min' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
      },
    },
  });

  // ── Chart 3: Inter-bite gaps (bar) ─────────────────────
  if (count < 2) {
    const cvs = document.getElementById('chartGaps');
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#aaa';
    ctx.font = '12px DM Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Need ≥ 2 bites for gap data', cvs.clientWidth / 2, 50);
  } else {
    const gaps      = bites.slice(1).map((b, i) => +((b.start - bites[i].end) / 1000).toFixed(2));
    const gapLabels = gaps.map((_, i) => `${i + 1}→${i + 2}`);
    const avgGap    = gaps.reduce((s, g) => s + g, 0) / gaps.length;

    if (state.charts.gaps) state.charts.gaps.destroy();
    state.charts.gaps = new Chart(document.getElementById('chartGaps'), {
      type: 'bar',
      data: {
        labels: gapLabels,
        datasets: [{
          label: 'Gap (s)',
          data: gaps,
          backgroundColor: gaps.map(g =>
            g > avgGap * 1.5 ? 'rgba(63,99,160,0.8)' : 'rgba(63,99,160,0.35)'
          ),
          borderColor: 'rgba(63,99,160,1)',
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { ...cd(), boxWidth: 12 } },
          tooltip: { callbacks: { label: c => ` ${c.parsed.y}s pause` } },
        },
        scales: {
          x: { ticks: { ...cd(), maxRotation: 30 }, grid: { color: 'rgba(0,0,0,0.05)' } },
          y: { ticks: { ...cd(), callback: v => v + 's' }, grid: { color: 'rgba(0,0,0,0.05)' }, beginAtZero: true },
        },
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────
// 11. SURVEY SUBMISSION
// ─────────────────────────────────────────────────────────────

async function submitSurvey(e) {
  e.preventDefault();

  const name        = ui.fieldName.value.trim();
  const context     = ui.fieldContext.value;
  const stress      = ui.fieldStress.value;
  const distraction = ui.fieldDistraction.value;
  const notes       = ui.fieldNotes.value.trim();

  if (!name || !context || !stress || !distraction) {
    showSubmitStatus('Please fill in all required fields.', 'error');
    return;
  }

  const { bites, mealStartTime, mealEndTime } = state;
  const mealMs   = mealStartTime && mealEndTime ? mealEndTime - mealStartTime : 0;
  const biteDurs = bites.map(b => +((b.duration / 1000).toFixed(2)));
  const avgDur   = biteDurs.length ? +(biteDurs.reduce((s, d) => s + d, 0) / biteDurs.length).toFixed(2) : 0;
  const pace     = mealMs > 0 && bites.length > 0 ? +(bites.length / (mealMs / 60000)).toFixed(2) : 0;

  ui.btnSubmit.disabled = true;
  showSubmitStatus('Sending…', '');

  try {
    const res = await fetch(CONFIG.SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, context, stress, distraction, notes,
        meal_time: (mealMs / 1000).toFixed(1),
        bites: bites.length,
        avg_bite_duration: avgDur,
        pace,
        bite_durations: biteDurs,
      }),
    });
    if (res.ok) {
      showSubmitStatus('Submitted successfully! ✓', 'success');
      ui.btnSubmit.textContent = 'Submitted ✓';
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    showSubmitStatus('Submission failed. Check connection and try again.', 'error');
    ui.btnSubmit.disabled = false;
    console.error('[BiteTrack]', err);
  }
}

function showSubmitStatus(msg, type) {
  ui.submitStatus.hidden    = false;
  ui.submitStatus.textContent = msg;
  ui.submitStatus.className = 'submit-status ' + type;
}

// ─────────────────────────────────────────────────────────────
// 12. UTILITIES
// ─────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateMotionBar(mag) {
  const pct = Math.min((mag / CONFIG.MOTION_BAR_MAX) * 100, 100);
  ui.motionBar.style.width    = pct + '%';
  ui.motionValue.textContent  = mag.toFixed(1);
  ui.motionBar.style.background = mag >= CONFIG.BITE_THRESHOLD
    ? 'linear-gradient(90deg, #f5b4af, var(--danger))'
    : 'linear-gradient(90deg, var(--accent-light), var(--accent))';
}

let biteFlashTimer = null;
function flashBiteIndicator() {
  ui.biteIndicator.classList.add('visible');
  clearTimeout(biteFlashTimer);
  biteFlashTimer = setTimeout(() => ui.biteIndicator.classList.remove('visible'), 700);
}

const BADGE = { idle: 'Idle', ready: 'Ready', eating: 'Eating', done: 'Done' };
function setStatusBadge(s) {
  ui.statusBadge.textContent = BADGE[s] || s;
  ui.statusBadge.className   = `status-badge status-${s}`;
}

// ─────────────────────────────────────────────────────────────
// 13. EVENT LISTENERS
// ─────────────────────────────────────────────────────────────

ui.btnEnable.addEventListener('click',   enableMotion);
ui.btnStart.addEventListener('click',    startMeal);
ui.btnEnd.addEventListener('click',      endMeal);
ui.btnReset.addEventListener('click',    resetAll);
ui.surveyForm.addEventListener('submit', submitSurvey);
