import ActivationInsightsLayout from "./ActivationInsightsLayout";
import ActivationMap from "./ActivationMap";
import "./LiveActivationPostDeploy.css";

/**
 * @typedef {{ pageTitle: string; name: string; id: string }} LiveRegItem
 * @typedef {{
 *   deployedAt: string;
 *   pagesCount: number;
 *   activeLayerTitle: string;
 *   rulesTotal: number;
 *   activeNodesTotal: number;
 *   gatewaysTotal: number;
 *   unregisteredNodes: LiveRegItem[];
 *   unregisteredGateways: LiveRegItem[];
 *   mapSnapshot?: {
 *     viewBox: string;
 *     layers: object[];
 *     defs?: string;
 *     pois: object[];
 *     gateways?: object[];
 *     metersPerSvgUserUnit?: number;
 *     flatSamples?: object[];
 *   } | null;
 * }} LivePostDeployData
 */

/**
 * @param {{ data: LivePostDeployData; onClose: () => void }} props
 */
export default function LiveActivationPostDeploy({ data, onClose }) {
  const deployedLabel = data.deployedAt ? new Date(data.deployedAt).toLocaleString() : "—";
  const nodeCount = data.unregisteredNodes.length;
  const gwCount = data.unregisteredGateways.length;
  const totalIssues = nodeCount + gwCount;
  const map = data.mapSnapshot;

  return (
    <div className="mas-live-post">
      <ActivationInsightsLayout
        fill
        variant="live"
        title="Activation insights"
        subtitle="Deployment overview · same layout as rehearsal. Pair devices before expecting live KPIs."
        mapCaption={map ? "Plan · layer active when you deployed" : "Plan preview unavailable"}
        className="mas-live-post-insights"
        heatmap={
          map?.viewBox ? (
            <div className="mas-live-post-map-inner">
              <ActivationMap
                key="live-deploy-map"
                viewBox={map.viewBox}
                layers={map.layers || []}
                defs={map.defs || ""}
                pois={map.pois || []}
                gateways={map.gateways || []}
                uncoveredPoiIds={null}
                metersPerSvgUserUnit={map.metersPerSvgUserUnit ?? 0.05}
                placingPoi={false}
                onPlacePoi={() => {}}
                selectedPoiId={null}
                onSelectPoi={() => {}}
                onMovePoi={() => {}}
                placingGateway={false}
                onPlaceGateway={() => {}}
                selectedGatewayId={null}
                onSelectGateway={() => {}}
                onMoveGateway={() => {}}
                avatarContent={{ x: 0, y: 0 }}
                onAvatarMove={() => {}}
                flatSamples={map.flatSamples || []}
                previewOnlyAvatar
                hideAvatar
                mode="preview"
                mapBackdropFill="#ffffff"
              />
            </div>
          ) : (
            <div className="mas-live-post-map-inner mas-live-post-map-inner--fallback" role="status">
              <span>No floorplan snapshot was attached to this stub response.</span>
            </div>
          )
        }
      >
        <div className="mas-live-post-metrics">
          <div className="mas-live-post-dash-grid">
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Status</span>
              <span className="mas-live-post-dash-v mas-live-post-dash-v--ok">Deployed</span>
            </div>
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Pushed at</span>
              <span className="mas-live-post-dash-v">{deployedLabel}</span>
            </div>
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Layers</span>
              <span className="mas-live-post-dash-v">{data.pagesCount}</span>
            </div>
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Active nodes (all layers)</span>
              <span className="mas-live-post-dash-v">{data.activeNodesTotal}</span>
            </div>
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Gateways (all layers)</span>
              <span className="mas-live-post-dash-v">{data.gatewaysTotal}</span>
            </div>
            <div className="mas-live-post-dash-card">
              <span className="mas-live-post-dash-k">Rules (all layers)</span>
              <span className="mas-live-post-dash-v">{data.rulesTotal}</span>
            </div>
            <div className="mas-live-post-dash-card mas-live-post-dash-card--wide">
              <span className="mas-live-post-dash-k">Active layer when deployed</span>
              <span className="mas-live-post-dash-v">{data.activeLayerTitle || "—"}</span>
            </div>
          </div>
        </div>
      </ActivationInsightsLayout>

      <div
        className="mas-live-post-modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mas-live-post-modal-title"
        aria-describedby="mas-live-post-modal-desc"
      >
        <div className="mas-live-post-modal" onClick={(e) => e.stopPropagation()}>
          <div className="mas-live-post-modal-icon" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <h2 id="mas-live-post-modal-title" className="mas-live-post-modal-title">
            Registration required
          </h2>
          <p id="mas-live-post-modal-desc" className="mas-live-post-modal-desc">
            Live traffic needs physical devices linked to your plan. The items below are still{" "}
            <strong>unregistered</strong> (no device pairing). Pair them in the editor with the setup app when
            available.
          </p>

          {totalIssues === 0 ? (
            <p className="mas-live-post-modal-empty">All nodes and gateways are registered.</p>
          ) : (
            <div className="mas-live-post-lists">
              {nodeCount > 0 ? (
                <div className="mas-live-post-list-block">
                  <h3 className="mas-live-post-list-title">Unregistered nodes ({nodeCount})</h3>
                  <ul className="mas-live-post-list">
                    {data.unregisteredNodes.map((row) => (
                      <li key={`n-${row.id}-${row.pageTitle}`}>
                        <span className="mas-live-post-list-name">{row.name}</span>
                        <span className="mas-live-post-list-meta">Layer: {row.pageTitle}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {gwCount > 0 ? (
                <div className="mas-live-post-list-block">
                  <h3 className="mas-live-post-list-title">Unregistered gateways ({gwCount})</h3>
                  <ul className="mas-live-post-list">
                    {data.unregisteredGateways.map((row) => (
                      <li key={`g-${row.id}-${row.pageTitle}`}>
                        <span className="mas-live-post-list-name">{row.name}</span>
                        <span className="mas-live-post-list-meta">Layer: {row.pageTitle}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          <div className="mas-live-post-modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Back to editor
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
