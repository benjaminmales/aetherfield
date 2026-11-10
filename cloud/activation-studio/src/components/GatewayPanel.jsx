import { targetRadiusM, MAX_DETECTION_RADIUS_M } from "../lib/ruleEval";
import PairingQrPlaceholder from "./PairingQrPlaceholder";
import "./GatewayPanel.css";

export default function GatewayPanel({
  gateways,
  selectedGatewayId,
  onSelect,
  onClearSelect,
  onUpdate,
  onDelete,
  placingGateway,
  onTogglePlace,
  pairingPageId,
}) {
  const selected = gateways.find((g) => g.id === selectedGatewayId) || null;

  return (
    <div className="gw-panel">
      <div className="gw-panel-head">
        <h2>Gateways</h2>
        <button
          type="button"
          className={`btn btn-sm${placingGateway ? " btn-active" : ""}`}
          onClick={onTogglePlace}
        >
          {placingGateway ? "Click map to place…" : "+ Add gateway"}
        </button>
      </div>
      <p className="gw-panel-hint">
        Gateways listen to bands and talk to the cloud. Rules target gateways: one fires when a
        guest is inside a gateway&rsquo;s detection radius. Physical gateways are linked later by
        scanning a QR / NFC on the device.
      </p>
      {placingGateway && <div className="gw-placing-hint">Click the map to place a gateway.</div>}
      <div className="gw-layout">
        <ul
          className="gw-list"
          onClick={(e) => e.target === e.currentTarget && onClearSelect?.()}
        >
          {gateways.map((g) => {
            const isSel = selectedGatewayId === g.id;
            return (
              <li key={g.id} className={isSel ? "gw-item gw-item--sel" : "gw-item"}>
                <button type="button" className="gw-item-main" onClick={() => onSelect(g.id)}>
                  <span className="gw-item-name">{g.name || "Unnamed gateway"}</span>
                  <span className="gw-item-meta">
                    r = {targetRadiusM(g)} m · {g.deviceId ? "paired" : "unpaired"}
                    {g.active === false ? " · off" : ""}
                  </span>
                </button>
              </li>
            );
          })}
          {gateways.length === 0 && (
            <li className="gw-empty">No gateways yet. Use “Add gateway” then click the plan.</li>
          )}
        </ul>

        {selected ? (
          <>
            <button
              type="button"
              className="panel-popout-backdrop"
              onClick={() => onClearSelect?.()}
            />
            <div className="gw-inspector" onClick={(e) => e.stopPropagation()}>
              <div className="gw-item-detail">
                <label>
                  Name
                  <input
                    type="text"
                    value={selected.name || ""}
                    placeholder="e.g. Main hall gateway"
                    onChange={(e) => onUpdate(selected.id, { name: e.target.value })}
                  />
                </label>
                <label>
                  Detection radius (m)
                  <input
                    type="range"
                    min={1}
                    max={MAX_DETECTION_RADIUS_M}
                    value={targetRadiusM(selected)}
                    onChange={(e) =>
                      onUpdate(selected.id, { detectionRadiusM: Number(e.target.value) })
                    }
                  />
                  <span className="gw-fixed-range-val">{targetRadiusM(selected)} m</span>
                </label>
                <label className="gw-check">
                  <input
                    type="checkbox"
                    checked={selected.active !== false}
                    onChange={(e) => onUpdate(selected.id, { active: e.target.checked })}
                  />
                  Active
                </label>
                <div className="gw-pair-block">
                  <div className="gw-pair-title">Physical pairing</div>
                  {selected.deviceId ? (
                    <div className="gw-pair-status gw-pair-status--paired">
                      Paired with <code>{selected.deviceId}</code>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => onUpdate(selected.id, { deviceId: null })}
                      >
                        Unpair
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="gw-pair-status">
                        Unpaired. Use the Aetherfield setup app to link this gateway by scanning
                        its QR / NFC.
                      </div>
                      <PairingQrPlaceholder kind="gateway" virtualId={selected.id} pageId={pairingPageId} />
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => onDelete(selected.id)}
                >
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
