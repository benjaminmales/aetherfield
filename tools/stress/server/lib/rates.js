/**
 * rates.js — per-second counters over a sliding window.
 *
 * The instantaneous rate is useless here: beacons arrive in bursts shaped by
 * the load generators' slot timing, so a one-second sample swings wildly and
 * an operator watching it learns nothing. A sliding window over N seconds is
 * what makes "are we losing frames" answerable while somebody is standing
 * there changing the beacon rate.
 *
 * Deliberately not an EWMA: when you halve the offered load you want the
 * number to actually settle at the new value within a known time, not
 * asymptotically approach it while the client watches.
 */
function createRate(windowSec = 20, now = () => Date.now()) {
  const buckets = new Array(windowSec).fill(0);
  const stamps = new Array(windowSec).fill(0);

  function idx(t) {
    return Math.floor(t / 1000) % windowSec;
  }

  function add(n = 1) {
    const t = now();
    const i = idx(t);
    const sec = Math.floor(t / 1000);
    if (stamps[i] !== sec) {
      stamps[i] = sec;
      buckets[i] = 0;
    }
    buckets[i] += n;
  }

  /** Mean per second over the window, ignoring buckets that are stale. */
  function perSecond() {
    const sec = Math.floor(now() / 1000);
    let total = 0;
    let live = 0;
    for (let i = 0; i < windowSec; i++) {
      // The current second is still filling; counting it drags the mean down.
      if (stamps[i] >= sec - windowSec && stamps[i] < sec) {
        total += buckets[i];
        live += 1;
      }
    }
    return live ? total / live : 0;
  }

  function reset() {
    buckets.fill(0);
    stamps.fill(0);
  }

  return { add, perSecond, reset, windowSec };
}

module.exports = { createRate };
