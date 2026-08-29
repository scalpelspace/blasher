/**
 * Hands-free boot control for the Blasher 5-pin breakout.
 *
 *   Pin 1: USART1_TX   Pin 2: USART1_RX   Pin 3: GND
 *   Pin 4: BOOT0       Pin 5: NRESET
 *
 * BOOT0 and NRESET are driven from the CP2102N modem control lines. Which
 * line goes where - and its polarity - depends on the board, so both are
 * configurable; the defaults match PyBlasher (NRST on RTS, asserted when the
 * RTS signal is deasserted, per the 100 nF AC-coupled reset wiring).
 */

import {sleep} from "./serial.js";

export const DEFAULT_PINS = {
  nrstLine: "rts", // "rts" | "dtr"
  nrstInvert: true, // asserting reset drives the signal false
  boot0Line: "dtr", // "rts" | "dtr"
  boot0Invert: false, // asserting BOOT0 drives the signal true
  resetHoldMs: 50, // how long NRST is held asserted
  bootDelayMs: 150, // settle time after reset release before the sync byte
};

const signalName = (line) => line === "rts" ? "requestToSend" : "dataTerminalReady";

export class Target {
  /**
   * @param {import("./serial.js").SerialTransport} transport
   * @param {Partial<typeof DEFAULT_PINS>} [pins]
   * @param {(msg: string, level?: string) => void} [log]
   */
  constructor(transport, pins = {}, log = () => {
  }) {
    this.io = transport;
    this.pins = {...DEFAULT_PINS, ...pins};
    this.log = log;
  }

  /**
   * Drive both control lines. `nrst: true` holds the MCU in reset,
   * `boot0: true` selects the system bootloader at the next reset release.
   */
  async setLines({nrst, boot0}) {
    const {nrstLine, nrstInvert, boot0Line, boot0Invert} = this.pins;
    const signals = {};
    signals[signalName(nrstLine)] = nrstInvert ? !nrst : nrst;
    signals[signalName(boot0Line)] = boot0Invert ? !boot0 : boot0;
    if (nrstLine === boot0Line) {
      throw new Error("BOOT0 and NRESET cannot share the same control line");
    }
    await this.io.setSignals(signals);
  }

  /** Release both lines: target free-running, BOOT0 low. */
  async idle() {
    await this.setLines({nrst: false, boot0: false});
  }

  async pulseReset(boot0) {
    await this.setLines({nrst: true, boot0});
    await sleep(this.pins.resetHoldMs);
    await this.setLines({nrst: false, boot0});
  }

  /** Reset with BOOT0 held high so the MCU starts the system bootloader. */
  async enterBootloader() {
    this.log("Asserting BOOT0 and pulsing NRESET");
    await this.setLines({nrst: false, boot0: true});
    await sleep(10);
    await this.pulseReset(true);
    await sleep(this.pins.bootDelayMs);
    this.io.flushInput();
  }

  /** Release BOOT0 and reset so the freshly flashed application runs. */
  async runApplication() {
    this.log("Releasing BOOT0 and pulsing NRESET to start the application");
    await this.setLines({nrst: false, boot0: false});
    await sleep(10);
    await this.pulseReset(false);
    await sleep(this.pins.bootDelayMs);
  }
}
