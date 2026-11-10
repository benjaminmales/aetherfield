import "./ActivationInsightsLayout.css";

/**
 * Shared shell for live deploy review and rehearsal (simulation) dashboards:
 * hero heatmap/map band + scrollable metrics below for visual continuity between modes.
 *
 * @param {{
 *   variant: "live" | "rehearsal";
 *   title?: string;
 *   subtitle?: import("react").ReactNode;
 *   heatmap: import("react").ReactNode;
 *   children: import("react").ReactNode;
 *   actions?: import("react").ReactNode;
 *   mapCaption?: string;
 *   className?: string;
 *   fill?: boolean;
 * }} props
 */
export default function ActivationInsightsLayout({
  variant,
  title,
  subtitle,
  heatmap,
  children,
  actions,
  mapCaption,
  className,
  /** Stretch to fill parent when used inside fixed full-screen overlays. */
  fill,
}) {
  const badge = variant === "live" ? "Live" : "Rehearsal";
  const resolvedTitle =
    title ?? (variant === "live" ? "Activation insights" : "Activation insights · rehearsal");
  const resolvedSubtitle =
    subtitle ??
    (variant === "live"
      ? "Plan view and deployment summary — pair devices to go live."
      : "Synthetic footfall and rule sampling — same layout as live review.");

  const rootClass = ["mas-insights", fill ? "mas-insights--fill" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rootClass} data-mas-insights-variant={variant}>
      <header className="mas-insights-top">
        <div className="mas-insights-top-text">
          <div className="mas-insights-title-row">
            <span className={`mas-insights-badge mas-insights-badge--${variant}`}>{badge}</span>
            <h2 className="mas-insights-title">{resolvedTitle}</h2>
          </div>
          <p className="mas-insights-sub">{resolvedSubtitle}</p>
        </div>
        {actions ? <div className="mas-insights-actions">{actions}</div> : null}
      </header>

      <div className="mas-insights-heatmap-wrap">
        {mapCaption ? <p className="mas-insights-map-caption">{mapCaption}</p> : null}
        <div className="mas-insights-heatmap">{heatmap}</div>
      </div>

      <div className="mas-insights-detail">{children}</div>
    </div>
  );
}
