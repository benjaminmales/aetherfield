import "./WristbandSyncPanel.css";

export default function WristbandSyncPanel({
  realSyncEnabled,
  setRealSyncEnabled,
  syncTransport,
  setSyncTransport,
  bridgeUrl,
  setBridgeUrl,
  syncStatus,
  serialConnected,
  serialSupported,
  connectWebSerial,
  disconnectWebSerial,
  wristbandReady,
}) {
  return (
    <div className="wrist-panel">
      <h2>Wristband sync</h2>
      <label className="wrist-row">
        <input type="checkbox" checked={realSyncEnabled} onChange={(e) => setRealSyncEnabled(e.target.checked)} />
        Enable live hardware / bridge
      </label>
      <div className="wrist-row">
        <span>Transport</span>
        <select value={syncTransport} onChange={(e) => setSyncTransport(e.target.value)}>
          <option value="webserial">Web Serial</option>
          <option value="bridge">HTTP bridge</option>
        </select>
      </div>
      {syncTransport === "bridge" && (
        <label className="wrist-bridge">
          Bridge URL
          <input type="text" value={bridgeUrl} onChange={(e) => setBridgeUrl(e.target.value)} />
        </label>
      )}
      {syncTransport === "webserial" && (
        <div className="wrist-serial-btns">
          {!serialConnected ? (
            <button type="button" className="btn" disabled={!serialSupported} onClick={connectWebSerial}>
              {serialSupported ? "Connect serial…" : "Serial not supported"}
            </button>
          ) : (
            <button type="button" className="btn" onClick={disconnectWebSerial}>
              Disconnect
            </button>
          )}
        </div>
      )}
      <p className={`wrist-status ${wristbandReady ? "wrist-status--ok" : ""}`}>{syncStatus}</p>
      <p className="wrist-hint">Uses the same <code>aura mode rate r g b</code> line as the cloud controller Show Control bridge.</p>
    </div>
  );
}
