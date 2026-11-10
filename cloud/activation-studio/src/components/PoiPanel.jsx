import PairingQrPlaceholder from "./PairingQrPlaceholder";
import "./PoiPanel.css";

export default function PoiPanel({
  pois,
  selectedPoiId,
  onSelect,
  onClearSelect,
  onUpdate,
  onDelete,
  placingPoi,
  onTogglePlace,
  pairingPageId,
}) {
  const selectedPoi = pois.find((p) => p.id === selectedPoiId) || null;

  return (
    <div className="poi-panel">
      <div className="poi-panel-head">
        <h2>Activation nodes</h2>
        <button type="button" className={`btn btn-sm${placingPoi ? " btn-active" : ""}`} onClick={onTogglePlace}>
          {placingPoi ? "Click map to place…" : "+ Add node"}
        </button>
      </div>
      <p className="poi-panel-hint">
        Name each node, radius 1–30 m. Drag markers on the map. Each node must be paired with a physical
        listener device (QR / NFC flow — same as gateways — ships in a later setup app).
      </p>
      {placingPoi && <div className="poi-placing-hint">Click the map to place a node.</div>}
      <div className="poi-layout">
        <ul className="poi-list" onClick={(e) => e.target === e.currentTarget && onClearSelect?.()}>
          {pois.map((p) => (
            <li key={p.id} className={selectedPoiId === p.id ? "poi-item poi-item--sel" : "poi-item"}>
              <button type="button" className="poi-item-main" onClick={() => onSelect(p.id)}>
                <span className="poi-item-name">{p.name || "Unnamed"}</span>
                <span className="poi-item-meta">
                  r = {p.activationRadiusM ?? 5} m · {p.deviceId ? "paired" : "unpaired"}
                </span>
              </button>
            </li>
          ))}
          {pois.length === 0 && <li className="poi-empty">No nodes yet. Use “Add node” then click the plan.</li>}
        </ul>

        {selectedPoi ? (
          <>
            <button type="button" className="panel-popout-backdrop" onClick={() => onClearSelect?.()} />
            <div className="poi-inspector" onClick={(e) => e.stopPropagation()}>
            <div className="poi-item-detail">
              <label>
                Name
                <input
                  type="text"
                  value={selectedPoi.name}
                  placeholder="e.g. BMW i7"
                  onChange={(e) => onUpdate(selectedPoi.id, { name: e.target.value })}
                />
              </label>
              <label>
                Radius (m)
                <input
                  type="range"
                  min={1}
                  max={30}
                  value={Math.min(30, Math.max(1, Number(selectedPoi.activationRadiusM) || 5))}
                  onChange={(e) => onUpdate(selectedPoi.id, { activationRadiusM: Number(e.target.value) })}
                />
                <span className="poi-radius-val">
                  {Math.min(30, Math.max(1, Number(selectedPoi.activationRadiusM) || 5))} m
                </span>
              </label>
              <label className="poi-check">
                <input
                  type="checkbox"
                  checked={selectedPoi.active !== false}
                  onChange={(e) => onUpdate(selectedPoi.id, { active: e.target.checked })}
                />
                Active
              </label>
              <div className="poi-pair-block">
                <div className="poi-pair-title">Physical pairing</div>
                {selectedPoi.deviceId ? (
                  <div className="poi-pair-status poi-pair-status--paired">
                    Paired with <code>{selectedPoi.deviceId}</code>
                    <button
                      type="button"
                      className="poi-pair-unlink"
                      onClick={() => onUpdate(selectedPoi.id, { deviceId: null })}
                    >
                      Unpair
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="poi-pair-status">
                      Unpaired. Use the Aetherfield setup app to link this node by scanning its QR / NFC.
                    </div>
                    <PairingQrPlaceholder kind="node" virtualId={selectedPoi.id} pageId={pairingPageId} />
                  </>
                )}
              </div>
              <button type="button" className="btn btn-danger" onClick={() => onDelete(selectedPoi.id)}>
                Delete
              </button>
            </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
