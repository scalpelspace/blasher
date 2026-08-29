/** Blasher web app: UI wiring and the flash sequence. */

import {
  SerialTransport, describePort, isSupported, requestPort, sleep,
} from "./serial.js";
import {Bootloader, padImage} from "./stm32.js";
import {DEFAULT_PINS, Target} from "./target.js";
import {describeDevice} from "./devices.js";

const $ = (id) => document.getElementById(id);

const els = {
  connStatus: $("connStatus"),
  connText: $("connText"),
  unsupported: $("unsupported"),
  btnConnect: $("btnConnect"),
  btnDisconnect: $("btnDisconnect"),
  chkAnyPort: $("chkAnyPort"),
  deviceFacts: $("deviceFacts"),
  factPort: $("factPort"),
  factTarget: $("factTarget"),
  factBootloader: $("factBootloader"),
  dropZone: $("dropZone"),
  fileInput: $("fileInput"),
  fileFacts: $("fileFacts"),
  factName: $("factName"),
  factSize: $("factSize"),
  factCrc: $("factCrc"),
  optErase: $("optErase"),
  optVerify: $("optVerify"),
  optRun: $("optRun"),
  btnFlash: $("btnFlash"),
  btnAbort: $("btnAbort"),
  progressWrap: $("progressWrap"),
  progressFill: $("progressFill"),
  progressPhase: $("progressPhase"),
  progressPct: $("progressPct"),
  btnAssertBoot0: $("btnAssertBoot0"),
  btnReleaseLines: $("btnReleaseLines"),
  btnPulseReset: $("btnPulseReset"),
  btnProbe: $("btnProbe"),
  btnResetSettings: $("btnResetSettings"),
  btnClearLog: $("btnClearLog"),
  log: $("log"),
};

const CONFIG_FIELDS = ["cfgBaud", "cfgParity", "cfgBase", "cfgAckTimeout", "cfgEraseTimeout", "cfgNrstLine", "cfgNrstInvert", "cfgBoot0Line", "cfgBoot0Invert", "cfgResetHold", "cfgBootDelay",];
for (const id of CONFIG_FIELDS) els[id] = $(id);

const state = {
  io: null,
  target: null,
  bl: null,
  image: null,
  imageName: null,
  busy: false,
  abort: false,
};

class AbortedError extends Error {
  constructor() {
    super("Aborted by user");
    this.name = "AbortedError";
  }
}

/* ------------------------------------------------------------------ log --- */

function log(message, level = "info") {
  const stamp = new Date().toLocaleTimeString([], {hour12: false});
  const line = document.createElement("span");
  line.className = `line ${level}`;
  line.textContent = `[${stamp}] ${message}\n`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

/* -------------------------------------------------------------- config --- */

const SETTINGS_KEY = "blasher.settings.v1";

/** Boot line settings alone - never throws, so the line tests always work. */
function readPins() {
  return {
    ...DEFAULT_PINS,
    nrstLine: els.cfgNrstLine.value,
    nrstInvert: els.cfgNrstInvert.checked,
    boot0Line: els.cfgBoot0Line.value,
    boot0Invert: els.cfgBoot0Invert.checked,
    resetHoldMs: Number(els.cfgResetHold.value) || DEFAULT_PINS.resetHoldMs,
    bootDelayMs: Number(els.cfgBootDelay.value) || DEFAULT_PINS.bootDelayMs,
  };
}

function readConfig() {
  return {
    baudRate: Number(els.cfgBaud.value) || 115200,
    parity: els.cfgParity.value,
    baseAddr: parseAddress(els.cfgBase.value),
    ackTimeout: Number(els.cfgAckTimeout.value) || 2000,
    eraseTimeout: Number(els.cfgEraseTimeout.value) || 40000,
    pins: readPins(),
  };
}

/** Addresses are always hex, with or without the 0x prefix. */
function parseAddress(text) {
  const cleaned = String(text).trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,8}$/i.test(cleaned)) {
    throw new Error(`Invalid flash base address: ${text}`);
  }
  return Number.parseInt(cleaned, 16) >>> 0;
}

function saveSettings() {
  const data = {};
  for (const id of CONFIG_FIELDS) {
    const el = els[id];
    data[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  for (const id of ["optErase", "optVerify", "optRun"]) {
    data[id] = els[id].checked;
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* private mode: settings just do not persist */
  }
}

function loadSettings() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {
    return;
  }
  if (!data) return;
  for (const [id, value] of Object.entries(data)) {
    const el = els[id];
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(value); else el.value = value;
  }
}

/**
 * Restore the advanced fields to the defaults written in index.html, then drop
 * just those keys from storage. Deleting rather than re-saving them means a
 * later change to a default reaches this browser instead of staying masked by
 * a saved copy of the old one.
 *
 * The flash options are deliberately untouched: they sit in plain view on the
 * page, so unlike the settings behind the collapsed panel they never get stuck
 * somewhere the user cannot see them.
 */
function resetSettings() {
  for (const id of CONFIG_FIELDS) {
    const el = els[id];
    if (el.type === "checkbox") {
      el.checked = el.defaultChecked;
    } else if (el.tagName === "SELECT") {
      const fallback = el.querySelector("option[selected]") || el.options[0];
      el.value = fallback.value;
    } else {
      el.value = el.defaultValue;
    }
  }

  let data = {};
  try {
    data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch {
    data = {};
  }
  for (const id of CONFIG_FIELDS) delete data[id];
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch {
    /* private mode: nothing was persisted to begin with */
  }

  // Keep an open connection consistent with what the form now shows.
  if (state.target) state.target.pins = readPins();
  if (state.bl) {
    const cfg = readConfig();
    state.bl.ackTimeout = cfg.ackTimeout;
    state.bl.eraseTimeout = cfg.eraseTimeout;
  }
  log("Advanced settings reset to defaults", "ok");
}

/* ----------------------------------------------------------------- ui ---- */

function setConnState(stateName, text) {
  els.connStatus.dataset.state = stateName;
  els.connText.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  const connected = state.io !== null;
  els.btnConnect.disabled = busy || connected;
  els.btnDisconnect.disabled = busy || !connected;
  els.btnFlash.disabled = busy || !connected || !state.image;
  els.btnAbort.disabled = !busy;
  for (const id of ["btnAssertBoot0", "btnReleaseLines", "btnPulseReset", "btnProbe"]) {
    els[id].disabled = busy || !connected;
  }
}

function setPhase(text, pct = null) {
  els.progressWrap.hidden = false;
  els.progressPhase.textContent = text;
  if (pct === null) {
    els.progressFill.classList.add("indeterminate");
    els.progressPct.textContent = "";
  } else {
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = `${pct.toFixed(1)}%`;
    els.progressPct.textContent = `${Math.round(pct)}%`;
  }
}

const progressReporter = (label) => (done, total) => {
  if (state.abort) throw new AbortedError();
  setPhase(`${label} ${done} / ${total} bytes`, (done / total) * 100);
};

function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  return `${(n / 1024).toFixed(1)} KiB (${n} bytes)`;
}

/* --------------------------------------------------------------- crc32 --- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------ connection - */

async function connect() {
  try {
    const port = await requestPort({anyDevice: els.chkAnyPort.checked});
    const cfg = readConfig();
    const io = new SerialTransport(port);
    await io.open({baudRate: cfg.baudRate, parity: cfg.parity});

    state.io = io;
    state.target = new Target(io, cfg.pins, log);
    state.bl = new Bootloader(io, {
      log, ackTimeout: cfg.ackTimeout, eraseTimeout: cfg.eraseTimeout,
    });

    // Opening the port may have asserted DTR/RTS: park the lines and let the
    // target settle before anything else touches it.
    await state.target.idle();
    await sleep(200);
    io.flushInput();

    els.deviceFacts.hidden = false;
    els.factPort.textContent = describePort(port);
    els.factTarget.textContent = "not probed";
    els.factBootloader.textContent = "not probed";
    setConnState("ok", `Connected @ ${cfg.baudRate} ${cfg.parity === "even" ? "8E1" : "8N1"}`);
    log(`Connected: ${describePort(port)} @ ${cfg.baudRate} baud`, "ok");
    setBusy(false);
  } catch (err) {
    if (err && err.name === "NotFoundError") {
      log("Port selection cancelled");
      return;
    }
    log(`Connect failed: ${err.message}`, "error");
    setConnState("error", "Connection failed");
  }
}

async function disconnect() {
  if (!state.io) return;
  try {
    await state.io.close();
  } catch (err) {
    log(`Close warning: ${err.message}`, "warn");
  }
  state.io = null;
  state.target = null;
  state.bl = null;
  els.deviceFacts.hidden = true;
  setConnState("idle", "Not connected");
  log("Disconnected");
  setBusy(false);
}

/* -------------------------------------------------------------- firmware - */

async function loadFile(file) {
  if (!file) return;
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.length === 0) {
    log(`${file.name} is empty`, "error");
    return;
  }
  if (/\.hex$|\.elf$/i.test(file.name)) {
    log(`${file.name} is not a raw binary - export a .bin image`, "error");
    return;
  }
  state.image = padImage(buffer);
  state.imageName = file.name;
  els.fileFacts.hidden = false;
  els.factName.textContent = file.name;
  els.factSize.textContent = formatBytes(buffer.length) + (state.image.length !== buffer.length ? ` -> padded to ${state.image.length}` : "");
  els.factCrc.textContent = "0x" + crc32(buffer).toString(16).padStart(8, "0").toUpperCase();
  els.dropZone.classList.add("loaded");
  log(`Loaded ${file.name} (${formatBytes(buffer.length)})`, "ok");
  setBusy(state.busy);
}

/* ------------------------------------------------------------- sequences - */

async function probe() {
  setBusy(true);
  try {
    setPhase("Probing target");
    await state.target.enterBootloader();
    await state.bl.sync();
    const info = await state.bl.get();
    els.factBootloader.textContent = `v${info.version >> 4}.${info.version & 0x0f}`;
    try {
      const id = await state.bl.getId();
      els.factTarget.textContent = describeDevice(id);
      log(`Target: ${describeDevice(id)}`, "ok");
    } catch (err) {
      els.factTarget.textContent = "unknown";
      log(`Get ID failed: ${err.message}`, "warn");
    }
    setPhase("Probe complete", 100);
  } catch (err) {
    log(`Probe failed: ${err.message}`, "error");
    setPhase("Probe failed", 0);
  } finally {
    setBusy(false);
  }
}

async function flash() {
  if (!state.io || !state.image) return;
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    log(err.message, "error");
    return;
  }
  state.target.pins = {...DEFAULT_PINS, ...cfg.pins};
  state.bl.ackTimeout = cfg.ackTimeout;
  state.bl.eraseTimeout = cfg.eraseTimeout;
  state.abort = false;
  setBusy(true);
  const started = performance.now();

  try {
    setPhase("Entering bootloader");
    await state.target.enterBootloader();
    await state.bl.sync();
    const info = await state.bl.get();
    els.factBootloader.textContent = `v${info.version >> 4}.${info.version & 0x0f}`;

    try {
      const id = await state.bl.getId();
      els.factTarget.textContent = describeDevice(id);
      log(`Target: ${describeDevice(id)}`);
    } catch (err) {
      log(`Get ID failed (continuing): ${err.message}`, "warn");
    }

    if (els.optErase.checked) {
      setPhase("Mass erasing flash");
      log("Mass erasing...");
      await state.bl.massErase();
    }
    if (state.abort) throw new AbortedError();

    log(`Writing ${state.image.length} bytes to 0x${cfg.baseAddr
      .toString(16)
      .padStart(8, "0")}`);
    await state.bl.writeImage(state.image, cfg.baseAddr, progressReporter("Writing"));

    if (els.optVerify.checked) {
      log("Verifying...");
      await state.bl.verifyImage(state.image, cfg.baseAddr, progressReporter("Verifying"));
      log("Verify OK", "ok");
    }

    if (els.optRun.checked) {
      setPhase("Starting application");
      await state.target.runApplication();
    } else {
      await state.target.setLines({nrst: false, boot0: false});
    }

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setPhase(`Done in ${seconds} s`, 100);
    log(`Firmware update successful (${seconds} s)`, "ok");
  } catch (err) {
    if (err instanceof AbortedError) {
      log("Aborted - target left in bootloader", "warn");
      setPhase("Aborted", 0);
    } else {
      log(`Flash failed: ${err.message}`, "error");
      setPhase("Failed", 0);
      hintFor(err);
    }
  } finally {
    state.abort = false;
    setBusy(false);
  }
}

function hintFor(err) {
  const msg = String(err.message || "");
  if (/sync|0x7F/i.test(msg)) {
    log("Hint: check the BOOT0/NRESET line mapping and polarity in Advanced " + "settings, confirm TX/RX are not swapped, and that the target is powered.", "warn");
  } else if (/NACK/i.test(msg)) {
    log("Hint: a NACK usually means readout protection is active or the address " + "is outside flash.", "warn");
  }
}

/* ---------------------------------------------------------------- wiring - */

function wire() {
  els.btnConnect.addEventListener("click", connect);
  els.btnDisconnect.addEventListener("click", disconnect);
  els.btnFlash.addEventListener("click", flash);
  els.btnProbe.addEventListener("click", probe);
  els.btnAbort.addEventListener("click", () => {
    state.abort = true;
    log("Abort requested - finishing current block", "warn");
  });
  els.btnResetSettings.addEventListener("click", resetSettings);
  els.btnClearLog.addEventListener("click", () => {
    els.log.textContent = "";
  });

  els.btnAssertBoot0.addEventListener("click", async () => {
    state.target.pins = readPins();
    await state.target.setLines({nrst: false, boot0: true});
    log("BOOT0 asserted, NRESET released");
  });
  els.btnReleaseLines.addEventListener("click", async () => {
    state.target.pins = readPins();
    await state.target.idle();
    log("BOOT0 and NRESET released");
  });
  els.btnPulseReset.addEventListener("click", async () => {
    state.target.pins = readPins();
    await state.target.pulseReset(false);
    log(`NRESET pulsed for ${state.target.pins.resetHoldMs} ms`);
  });

  els.fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));
  for (const type of ["dragenter", "dragover"]) {
    els.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropZone.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    els.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      els.dropZone.classList.remove("over");
    });
  }
  els.dropZone.addEventListener("drop", (e) => {
    loadFile(e.dataTransfer.files[0]);
  });

  for (const id of [...CONFIG_FIELDS, "optErase", "optVerify", "optRun"]) {
    els[id].addEventListener("change", saveSettings);
  }

  if (isSupported()) {
    navigator.serial.addEventListener("disconnect", (e) => {
      if (state.io && e.target === state.io.port) {
        log("Device unplugged", "error");
        disconnect();
      }
    });
  }
}

function init() {
  loadSettings();
  wire();
  if (!isSupported()) {
    els.unsupported.hidden = false;
    els.btnConnect.disabled = true;
    setConnState("error", "Web Serial unavailable");
    log("Web Serial API not available in this browser", "error");
    return;
  }
  setBusy(false);
  log("Ready. Connect the Blasher to begin.");
}

init();
