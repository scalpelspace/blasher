/** Blasher web app: UI wiring and the flash sequence. */

import {
  SerialTransport, describePort, isSupported, requestPort, sleep,
} from "./serial.js";
import {Bootloader, padImage} from "./stm32.js";
import {DEFAULT_PINS, Target} from "./target.js";
import {describeDevice} from "./devices.js";
import {StreamFormatter, encodeInput, hexdumpRow} from "./monitor.js";

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
  tabFlash: $("tabFlash"),
  tabSerial: $("tabSerial"),
  panelFlash: $("panelFlash"),
  panelSerial: $("panelSerial"),
  monPortState: $("monPortState"),
  monPortText: $("monPortText"),
  serialOut: $("serialOut"),
  monInput: $("monInput"),
  btnMonSend: $("btnMonSend"),
  btnMonReset: $("btnMonReset"),
  btnMonClear: $("btnMonClear"),
  monStats: $("monStats"),
  btnResetSettings: $("btnResetSettings"),
  btnClearLog: $("btnClearLog"),
  log: $("log"),
};

const CONFIG_FIELDS = ["cfgBaud", "cfgParity", "cfgBase", "cfgAckTimeout", "cfgEraseTimeout", "cfgNrstLine", "cfgNrstInvert", "cfgBoot0Line", "cfgBoot0Invert", "cfgResetHold", "cfgBootDelay",];
for (const id of CONFIG_FIELDS) els[id] = $(id);

/*
 * Monitor settings persist like the rest of the form, but are deliberately
 * outside the Advanced reset: they sit in plain view on the Serial tab, so
 * they cannot get stuck somewhere the user is not looking.
 */
const MONITOR_FIELDS = ["monBaud", "monFraming", "monLineEnding", "monEcho", "monTimestamps", "monHex", "monAutoscroll", "monSendHex",];
for (const id of MONITOR_FIELDS) els[id] = $(id);

const state = {
  io: null,
  target: null,
  bl: null,
  image: null,
  imageName: null,
  busy: false,
  abort: false,
  tab: "flash",
  /** Framing the port is currently open with, or null when closed. */
  portSettings: null,
  rxBytes: 0,
  txBytes: 0,
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
  for (const id of [...CONFIG_FIELDS, ...MONITOR_FIELDS]) {
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
  syncMonitor();
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

/* --------------------------------------------------------- serial monitor */

/** Oldest lines are dropped past this; a chatty target would otherwise grow
 *  the DOM without bound. */
const MAX_MONITOR_LINES = 2000;

/** Partial lines are held until the target sends more; this forces them out
 *  once it goes quiet, so a prompt with no newline still appears. */
const IDLE_FLUSH_MS = 150;

const formatter = new StreamFormatter();
let idleFlushTimer = null;

const framingLabel = (parity) => (parity === "even" ? "8E1" : "8N1");

function monitorSettings() {
  return {
    baudRate: Number(els.monBaud.value) || 115200, parity: els.monFraming.value,
  };
}

function flashSettings() {
  return {
    baudRate: Number(els.cfgBaud.value) || 115200, parity: els.cfgParity.value,
  };
}

/**
 * Reopen the port only when the framing actually has to change. Web Serial
 * cannot retune an open port, and the reopen toggles DTR/RTS, which resets
 * the target - so this stays quiet when the settings already match.
 */
async function ensurePort(settings, why) {
  if (!state.io) return;
  const now = state.portSettings;
  if (now && now.baudRate === settings.baudRate && now.parity === settings.parity) {
    return;
  }
  log(`Reopening port at ${settings.baudRate} ${framingLabel(settings.parity)} for ${why}; the target resets`, "warn");
  await state.io.reopen(settings);
  state.portSettings = {...settings};
  await state.target.idle();
  await sleep(150);
  state.io.flushInput();
  updatePortPill();
}

function updatePortPill() {
  const open = state.portSettings !== null;
  els.monPortState.dataset.state = open ? "ok" : "idle";
  els.monPortText.textContent = open ? `${state.portSettings.baudRate} ${framingLabel(state.portSettings.parity)}` : "Port closed";
}

function updateStats() {
  els.monStats.textContent = `${state.rxBytes} B in, ${state.txBytes} B out`;
}

function appendMonitor(lines, kind) {
  if (!lines.length) return;
  const stamp = els.monTimestamps.checked ? `[${new Date().toLocaleTimeString([], {hour12: false})}] ` : "";
  for (const text of lines) {
    const el = document.createElement("span");
    el.className = `line ${kind}`;
    el.textContent = `${stamp}${text}\n`;
    els.serialOut.appendChild(el);
  }
  while (els.serialOut.childElementCount > MAX_MONITOR_LINES) {
    els.serialOut.removeChild(els.serialOut.firstChild);
  }
  if (els.monAutoscroll.checked) {
    els.serialOut.scrollTop = els.serialOut.scrollHeight;
  }
}

function handleIncoming(bytes) {
  state.rxBytes += bytes.length;
  appendMonitor(formatter.push(bytes), "rx");
  updateStats();
  clearTimeout(idleFlushTimer);
  idleFlushTimer = setTimeout(() => appendMonitor(formatter.flush(), "rx"), IDLE_FLUSH_MS);
}

/**
 * The monitor owns the byte stream only while its tab is open, a port exists
 * and nothing else is driving the target. Anywhere else it must let go, or it
 * would eat the bootloader's ACKs.
 */
function syncMonitor() {
  const live = state.tab === "serial" && state.io !== null && !state.busy;
  if (state.io) state.io.onData = live ? handleIncoming : null;
  if (!live) {
    clearTimeout(idleFlushTimer);
    appendMonitor(formatter.flush(), "rx");
  }
  els.monInput.disabled = !live;
  els.btnMonSend.disabled = !live;
  els.btnMonReset.disabled = !live;
}

async function selectTab(name) {
  state.tab = name;
  for (const [tab, panel, key] of [[els.tabFlash, els.panelFlash, "flash"], [els.tabSerial, els.panelSerial, "serial"],]) {
    tab.setAttribute("aria-selected", String(name === key));
    panel.hidden = name !== key;
  }
  if (name === "serial" && state.io && !state.busy) {
    try {
      await ensurePort(monitorSettings(), "the serial monitor");
    } catch (err) {
      log(`Could not reopen the port: ${err.message}`, "error");
    }
  }
  syncMonitor();
}

async function sendInput() {
  if (!state.io || state.busy) return;
  // An empty text line is still a line: it sends just the ending.
  const text = els.monInput.value;
  let bytes;
  try {
    bytes = encodeInput(text, {
      hex: els.monSendHex.checked, lineEnding: els.monLineEnding.value,
    });
  } catch (err) {
    appendMonitor([`send: ${err.message}`], "error");
    return;
  }
  if (!bytes.length) return;
  try {
    await state.io.write(bytes);
  } catch (err) {
    appendMonitor([`send failed: ${err.message}`], "error");
    return;
  }
  state.txBytes += bytes.length;
  if (els.monEcho.checked) {
    appendMonitor([els.monSendHex.checked ? hexdumpRow(bytes, 0) : text], "tx");
  }
  els.monInput.value = "";
  updateStats();
}

async function resetTarget() {
  if (!state.target || state.busy) return;
  try {
    state.target.pins = readPins();
    await state.target.pulseReset(false);
    appendMonitor(["-- target reset --"], "meta");
  } catch (err) {
    appendMonitor([`reset failed: ${err.message}`], "error");
  }
}

function clearMonitor() {
  els.serialOut.textContent = "";
  formatter.reset();
  state.rxBytes = 0;
  state.txBytes = 0;
  updateStats();
}

/* ------------------------------------------------------------ connection - */

async function connect() {
  try {
    const port = await requestPort({anyDevice: els.chkAnyPort.checked});
    const cfg = readConfig();
    const io = new SerialTransport(port);
    await io.open({baudRate: cfg.baudRate, parity: cfg.parity});

    state.io = io;
    state.portSettings = {baudRate: cfg.baudRate, parity: cfg.parity};
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
    updatePortPill();
    setBusy(false);
    // Picks up monitor framing if the user connected from the Serial tab.
    if (state.tab === "serial") await selectTab("serial");
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
  state.io.onData = null;
  try {
    await state.io.close();
  } catch (err) {
    log(`Close warning: ${err.message}`, "warn");
  }
  state.io = null;
  state.target = null;
  state.bl = null;
  state.portSettings = null;
  updatePortPill();
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
    await ensurePort(flashSettings(), "the bootloader");
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
    await ensurePort({
      baudRate: cfg.baudRate, parity: cfg.parity
    }, "the bootloader");
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
  els.tabFlash.addEventListener("click", () => selectTab("flash"));
  els.tabSerial.addEventListener("click", () => selectTab("serial"));

  els.btnMonSend.addEventListener("click", sendInput);
  els.monInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendInput();
    }
  });
  els.btnMonReset.addEventListener("click", resetTarget);
  els.btnMonClear.addEventListener("click", clearMonitor);
  els.monHex.addEventListener("change", () => {
    appendMonitor(formatter.setHex(els.monHex.checked), "rx");
  });
  for (const id of ["monBaud", "monFraming"]) {
    els[id].addEventListener("change", async () => {
      if (state.tab !== "serial" || !state.io || state.busy) return;
      try {
        await ensurePort(monitorSettings(), "the serial monitor");
      } catch (err) {
        log(`Could not reopen the port: ${err.message}`, "error");
      }
    });
  }

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

  for (const id of [...CONFIG_FIELDS, ...MONITOR_FIELDS, "optErase", "optVerify", "optRun"]) {
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
  selectTab("flash");
  updatePortPill();
  updateStats();
  setBusy(false);
  log("Ready. Connect the Blasher to begin.");
}

init();
