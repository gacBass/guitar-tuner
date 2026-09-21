// ---- Note math -------------------------------------------------------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function frequencyToMidiNote(frequency, a4) {
  return 12 * Math.log2(frequency / a4) + 69;
}

function midiNoteToFrequency(note, a4) {
  return a4 * Math.pow(2, (note - 69) / 12);
}

function midiNoteToName(note) {
  const name = NOTE_NAMES[((Math.round(note) % 12) + 12) % 12];
  const octave = Math.floor(Math.round(note) / 12) - 1;
  return `${name}${octave}`;
}

function centsOffset(frequency, note, a4) {
  return Math.round(1200 * Math.log2(frequency / midiNoteToFrequency(note, a4)));
}

// ---- Tunings -----------------------------------------------------------

const TUNINGS = {
  guitar: [
    { name: "E2", freq: 82.41 },
    { name: "A2", freq: 110.0 },
    { name: "D3", freq: 146.83 },
    { name: "G3", freq: 196.0 },
    { name: "B3", freq: 246.94 },
    { name: "E4", freq: 329.63 },
  ],
  bass4: [
    { name: "E1", freq: 41.2 },
    { name: "A1", freq: 55.0 },
    { name: "D2", freq: 73.42 },
    { name: "G2", freq: 98.0 },
  ],
  bass5: [
    { name: "B0", freq: 30.87 },
    { name: "E1", freq: 41.2 },
    { name: "A1", freq: 55.0 },
    { name: "D2", freq: 73.42 },
    { name: "G2", freq: 98.0 },
  ],
  chromatic: null,
};

// ---- YIN pitch detection -------------------------------------------------
// Reference: de Cheveigne & Kawahara, "YIN, a fundamental frequency
// estimator for speech and music" (2002).

function detectPitchYin(buffer, sampleRate, threshold = 0.15) {
  const halfLength = Math.floor(buffer.length / 2);
  const yinBuffer = new Float32Array(halfLength);

  // Step 1-2: difference function + cumulative mean normalized difference
  yinBuffer[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfLength; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLength; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    runningSum += sum;
    yinBuffer[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
  }

  // Step 3: absolute threshold - find first dip below threshold
  let tauEstimate = -1;
  for (let tau = 2; tau < halfLength; tau++) {
    if (yinBuffer[tau] < threshold) {
      while (tau + 1 < halfLength && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return null;

  // Step 4: parabolic interpolation around the minimum for sub-sample accuracy
  const x0 = tauEstimate > 0 ? tauEstimate - 1 : tauEstimate;
  const x2 = tauEstimate + 1 < halfLength ? tauEstimate + 1 : tauEstimate;
  let betterTau = tauEstimate;
  if (x0 !== tauEstimate && x2 !== tauEstimate) {
    const s0 = yinBuffer[x0];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
  }

  const frequency = sampleRate / betterTau;
  const clarity = 1 - yinBuffer[tauEstimate];
  return { frequency, clarity };
}

// ---- Audio pipeline -------------------------------------------------

const BUFFER_SIZE = 4096;
const MIN_FREQ = 25; // below lowest bass B string
const MAX_FREQ = 1200;
const MIN_CLARITY = 0.85; // reject noisy / ambiguous frames

let audioContext = null;
let analyserSource = null;
let processor = null;
let mediaStream = null;
let listening = false;

// Smooths note readings across frames so the needle doesn't flicker.
const FRAME_HISTORY = 5;
let recentNotes = [];

const els = {
  note: document.getElementById("note"),
  freq: document.getElementById("freq"),
  status: document.getElementById("status"),
  needle: document.getElementById("needle"),
  a4Input: document.getElementById("a4Input"),
  strings: document.getElementById("strings"),
  instButtons: document.querySelectorAll(".inst-btn"),
  micPill: document.getElementById("micPill"),
  micPillText: document.getElementById("micPillText"),
  tapOverlay: document.getElementById("tapOverlay"),
  appTitle: document.getElementById("appTitle"),
  gaugeTicks: document.getElementById("gaugeTicks"),
};

function setMicState(state) {
  els.micPill.classList.remove("live", "muted", "denied", "compact");
  if (state === "live") {
    els.micPill.classList.add("live", "compact");
    els.micPillText.textContent = "Listening";
    els.micPillText.style.display = "none";
  } else if (state === "muted") {
    els.micPill.classList.add("muted");
    els.micPillText.textContent = "Muted";
    els.micPillText.style.display = "";
  } else if (state === "denied") {
    els.micPill.classList.add("denied");
    els.micPillText.textContent = "Mic blocked";
    els.micPillText.style.display = "";
  } else {
    els.micPillText.textContent = "Starting…";
    els.micPillText.style.display = "";
  }
}

function showTapOverlay() {
  els.tapOverlay.classList.add("visible");
}

function hideTapOverlay() {
  els.tapOverlay.classList.remove("visible");
}

// ---- Radial gauge ticks -------------------------------------------------

const GAUGE_TICKS = [
  { cents: -50, label: "-50", major: true, color: "var(--flat-color)" },
  { cents: -37.5, major: false },
  { cents: -25, label: "-25", major: true },
  { cents: -12.5, major: false },
  { cents: 0, label: "0", major: true, center: true },
  { cents: 12.5, major: false },
  { cents: 25, label: "+25", major: true },
  { cents: 37.5, major: false },
  { cents: 50, label: "+50", major: true, color: "var(--sharp-color)" },
];

function renderGaugeTicks() {
  els.gaugeTicks.innerHTML = "";
  GAUGE_TICKS.forEach((t) => {
    const angle = (t.cents / 50) * 45;
    const wrap = document.createElement("div");
    wrap.className = "radial-item";
    wrap.style.transform = `translateX(-50%) rotate(${angle}deg)`;

    const dash = document.createElement("div");
    dash.className = "tick-dash" + (t.major ? " major" : "") + (t.center ? " center" : "");
    if (t.color) dash.style.background = t.color;
    wrap.appendChild(dash);

    if (t.label !== undefined) {
      const label = document.createElement("span");
      label.className = "tick-label" + (t.center ? " center" : "");
      label.style.transform = `rotate(${-angle}deg)`;
      label.textContent = t.label;
      if (t.color) label.style.color = t.color;
      wrap.appendChild(label);
    }

    els.gaugeTicks.appendChild(wrap);
  });
}
renderGaugeTicks();

// ---- Instrument selection -------------------------------------------------

const TUNING_TITLES = {
  guitar: "Guitar Tuner",
  bass4: "Bass Tuner",
  bass5: "Bass Tuner (5-String)",
  chromatic: "Chromatic Tuner",
};

let currentTuningKey = "guitar";
renderStringChips();

els.instButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.instButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTuningKey = btn.dataset.tuning;
    els.appTitle.textContent = TUNING_TITLES[currentTuningKey];
    renderStringChips();
  });
});

function renderStringChips() {
  const tuning = TUNINGS[currentTuningKey];
  els.strings.innerHTML = "";
  if (!tuning) return;
  tuning.forEach((s) => {
    const chip = document.createElement("div");
    chip.className = "string-chip";
    chip.textContent = s.name;
    chip.dataset.name = s.name;
    els.strings.appendChild(chip);
  });
}

function highlightNearestString(frequency) {
  const tuning = TUNINGS[currentTuningKey];
  if (!tuning) return;
  let nearest = tuning[0];
  let nearestDist = Infinity;
  for (const s of tuning) {
    const dist = Math.abs(Math.log2(frequency / s.freq));
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = s;
    }
  }
  document.querySelectorAll(".string-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.name === nearest.name);
  });
}

function updateDisplay(frequency) {
  const a4 = parseFloat(els.a4Input.value) || 440;
  const midiNote = frequencyToMidiNote(frequency, a4);
  const rounded = Math.round(midiNote);

  recentNotes.push(rounded);
  if (recentNotes.length > FRAME_HISTORY) recentNotes.shift();
  const stableNote = mode(recentNotes);

  const cents = centsOffset(frequency, stableNote, a4);
  const clampedCents = Math.max(-50, Math.min(50, cents));

  els.note.textContent = midiNoteToName(stableNote);
  els.freq.textContent = `${frequency.toFixed(1)} Hz`;

  const angle = (clampedCents / 50) * 45; // -45deg..45deg
  els.needle.style.transform = `translateX(-50%) rotate(${angle}deg)`;

  const absCents = Math.abs(cents);
  let color = "var(--accent-green)";
  let statusText = "In tune";
  const inTune = absCents <= 5;
  if (absCents > 5 && absCents <= 15) {
    color = "var(--sharp-color)";
    statusText = cents > 0 ? "Slightly sharp" : "Slightly flat";
  } else if (absCents > 15) {
    color = "var(--flat-color)";
    statusText = cents > 0 ? "Sharp" : "Flat";
  }
  els.needle.style.setProperty("--needle-color", color);
  els.needle.classList.toggle("in-tune", inTune);
  els.note.classList.toggle("in-tune", inTune);
  els.status.textContent = statusText;

  highlightNearestString(frequency);
}

function mode(arr) {
  const counts = new Map();
  let best = arr[arr.length - 1];
  let bestCount = 0;
  for (const v of arr) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c >= bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

function processAudio(event) {
  const input = event.inputBuffer.getChannelData(0);
  const result = detectPitchYin(input, audioContext.sampleRate);

  if (
    !result ||
    result.clarity < MIN_CLARITY ||
    result.frequency < MIN_FREQ ||
    result.frequency > MAX_FREQ
  ) {
    els.status.textContent = listening ? "Listening..." : "";
    return;
  }

  updateDisplay(result.frequency);
}

async function startTuner() {
  setMicState("starting");
  els.status.textContent = "Getting ready…";

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    setMicState("denied");
    els.status.textContent = "Microphone blocked — tap to retry";
    showTapOverlay();
    return;
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyserSource = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

  analyserSource.connect(processor);
  // ScriptProcessorNode requires a destination connection to fire in some browsers.
  processor.connect(audioContext.destination);
  processor.onaudioprocess = processAudio;

  listening = true;
  recentNotes = [];
  setMicState("live");
  els.status.textContent = "Listening...";

  // Some browsers (notably iOS Safari) start a fresh AudioContext suspended
  // until a user gesture resumes it, even though getUserMedia succeeded.
  if (audioContext.state === "suspended") {
    showTapOverlay();
  } else {
    hideTapOverlay();
  }
}

function stopTuner() {
  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (analyserSource) {
    analyserSource.disconnect();
    analyserSource = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  listening = false;
  setMicState("muted");
  els.status.textContent = "Muted — tap the mic to resume";
  els.note.textContent = "–";
  els.note.classList.remove("in-tune");
  els.freq.textContent = "0.0 Hz";
  els.needle.style.transform = "translateX(-50%) rotate(0deg)";
  els.needle.classList.remove("in-tune");
  els.needle.style.removeProperty("--needle-color");
  document.querySelectorAll(".string-chip").forEach((c) => c.classList.remove("active"));
}

els.micPill.addEventListener("click", () => {
  if (listening) stopTuner();
  else startTuner();
});

els.tapOverlay.addEventListener("click", async () => {
  hideTapOverlay();
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (err) {
      /* ignore */
    }
  }
  if (!listening) startTuner();
});

// Auto-start as soon as the page is ready — no explicit "Start" step needed
// on platforms that allow it (most Android/desktop browsers). Platforms that
// require a user gesture fall back to the tap overlay above.
startTuner();
