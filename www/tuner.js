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
  startBtn: document.getElementById("startBtn"),
  a4Input: document.getElementById("a4Input"),
  strings: document.getElementById("strings"),
  instButtons: document.querySelectorAll(".inst-btn"),
};

let currentTuningKey = "guitar";
renderStringChips();

els.instButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.instButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTuningKey = btn.dataset.tuning;
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
    chip.classList.toggle("target", chip.dataset.name === nearest.name);
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
  let color = "#4fd1a0";
  let statusText = "In tune";
  if (absCents > 5 && absCents <= 15) {
    color = "#f0c14b";
    statusText = cents > 0 ? "Slightly sharp" : "Slightly flat";
  } else if (absCents > 15) {
    color = "#ef6a6a";
    statusText = cents > 0 ? "Sharp" : "Flat";
  }
  els.needle.style.background = color;
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
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    els.status.textContent = "Microphone access denied";
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
  els.startBtn.textContent = "Stop Tuner";
  els.startBtn.classList.add("listening");
  els.status.textContent = "Listening...";
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
  els.startBtn.textContent = "Start Tuner";
  els.startBtn.classList.remove("listening");
  els.status.textContent = "Tap start and play a note";
  els.note.textContent = "–";
  els.freq.textContent = "0.0 Hz";
  els.needle.style.transform = "translateX(-50%) rotate(0deg)";
  document.querySelectorAll(".string-chip").forEach((c) => c.classList.remove("target"));
}

els.startBtn.addEventListener("click", () => {
  if (listening) stopTuner();
  else startTuner();
});
