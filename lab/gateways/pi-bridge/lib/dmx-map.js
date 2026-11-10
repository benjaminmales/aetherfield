"use strict";

/**
 * dmx-map.js — shared DMX → band-command mapping engine.
 *
 * The gateway behaves as ONE DMX fixture: it reads a block of channels out of an
 * incoming DMX/Art-Net frame and turns them into a single {mode,rate,r,g,b}
 * command for its local bands. The band runs the animation locally — we only
 * send a command when the mapped values CHANGE (no pixel streaming), with a small
 * debounce so a fader sweep coalesces to its final value instead of flooding the
 * 802.15.4 link.
 *
 * Pure and dependency-free so the same engine runs on the gateway bridge today
 * and on the local Server later.
 *
 * Channel layouts (startChannel is 1-based, like a real DMX patch):
 *   "mrgb" (5 ch): [mode, rate, R, G, B]   mode scaled 0-255 -> 0-7
 *   "rgb"  (3 ch): [R, G, B]               mode/rate come from fixedMode/fixedRate
 */

function clamp(n, lo, hi) {
  n = Math.round(Number(n) || 0);
  return Math.min(hi, Math.max(lo, n));
}

function channelCount(layout) {
  return layout === "rgb" ? 3 : 5;
}

/** Decode the patched channels of a DMX frame into a band command. */
function decodeChannels(frame, dmx) {
  const start = clamp(dmx.startChannel || 1, 1, 512);
  const at = (ch) => {
    const i = ch - 1; // 1-based DMX channel -> 0-based byte index
    return i >= 0 && i < frame.length ? frame[i] & 0xff : 0;
  };

  if (dmx.layout === "rgb") {
    return {
      mode: clamp(dmx.fixedMode, 0, 7),
      rate: clamp(dmx.fixedRate, 0, 255),
      r: at(start),
      g: at(start + 1),
      b: at(start + 2),
    };
  }

  // mrgb (default): mode fader 0-255 maps onto the 8 band modes (0-7)
  return {
    mode: Math.min(7, at(start) >> 5),
    rate: at(start + 1),
    r: at(start + 2),
    g: at(start + 3),
    b: at(start + 4),
  };
}

function sameCmd(a, b) {
  return (
    !!a &&
    !!b &&
    a.mode === b.mode &&
    a.rate === b.rate &&
    a.r === b.r &&
    a.g === b.g &&
    a.b === b.b
  );
}

/**
 * Create a stateful mapper.
 * @param {object} dmx   - dmx config block { startChannel, layout, fixedMode, fixedRate, debounceMs }
 * @param {(mode,rate,r,g,b)=>void} send - called only when the command changes
 * @param {object} [opts] - { debounceMs, setTimeout, clearTimeout } (timer injection for tests)
 */
function createMapper(dmx, send, opts = {}) {
  const setT = opts.setTimeout || setTimeout;
  const clrT = opts.clearTimeout || clearTimeout;
  const debounce = Number.isFinite(opts.debounceMs)
    ? opts.debounceMs
    : Number.isFinite(dmx.debounceMs)
    ? dmx.debounceMs
    : 60;

  let lastSent = null;
  let lastDecoded = null;
  let pending = null;
  let timer = null;
  let sentCount = 0;

  function flush() {
    timer = null;
    if (pending && !sameCmd(pending, lastSent)) {
      lastSent = pending;
      sentCount++;
      const c = pending;
      pending = null;
      send(c.mode, c.rate, c.r, c.g, c.b);
      return c;
    }
    pending = null;
    return null;
  }

  function onFrame(frame) {
    const d = decodeChannels(frame, dmx);
    lastDecoded = d;
    if (sameCmd(d, lastSent)) {
      return { changed: false, decoded: d }; // unchanged -> send nothing
    }
    pending = d;
    if (debounce <= 0) {
      if (timer) {
        clrT(timer);
        timer = null;
      }
      flush();
    } else if (!timer) {
      timer = setT(flush, debounce); // coalesce a burst; pending keeps the latest
    }
    return { changed: true, decoded: d };
  }

  return {
    onFrame,
    flush,
    getState: () => ({ lastSent, lastDecoded, sentCount }),
    reset: () => {
      lastSent = null;
      pending = null;
      if (timer) {
        clrT(timer);
        timer = null;
      }
    },
  };
}

module.exports = { decodeChannels, sameCmd, createMapper, channelCount, clamp };
