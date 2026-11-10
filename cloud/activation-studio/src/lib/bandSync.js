const DEFAULT_BRIDGE_URL = import.meta.env.VITE_LED_BRIDGE_URL || "http://localhost:3000/api/led";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * @param {object} opts
 * @param {'webserial'|'bridge'} opts.transport
 * @param {string} opts.bridgeUrl
 * @param {WritableStreamDefaultWriter|null} opts.writer
 * @param {Promise<void>} opts.writeChain
 * @param {{ mode: number, rate: number, r: number, g: number, b: number }} cmd
 * @returns {Promise<{ writeChain: Promise<void> }>}
 */
export async function sendAuraCommand({ transport, bridgeUrl, writer, writeChain }, cmd) {
  const mode = clamp(Math.round(Number(cmd.mode) || 0), 0, 5);
  const rate = clamp(Math.round(Number(cmd.rate) || 100), 1, 255);
  const r = clamp(Math.round(Number(cmd.r) || 0), 0, 255);
  const g = clamp(Math.round(Number(cmd.g) || 0), 0, 255);
  const b = clamp(Math.round(Number(cmd.b) || 0), 0, 255);

  if (transport === "webserial") {
    if (!writer) throw new Error("Connect Web Serial first");
    const cmdText = `aura ${mode} ${rate} ${r} ${g} ${b}\r`;
    const bytes = new TextEncoder().encode(cmdText);
    const writeOnce = () => writer.write(bytes);
    const queued = writeChain.then(writeOnce, writeOnce);
    const nextChain = queued.catch(() => {});
    await queued;
    return { writeChain: nextChain };
  }

  const url = String(bridgeUrl || "").trim() || DEFAULT_BRIDGE_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    body: JSON.stringify({ mode, rate, r, g, b }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Bridge request failed (${res.status})`);
  return { writeChain };
}

export { DEFAULT_BRIDGE_URL };
