import "./SimpleBandPreview.css";

export default function SimpleBandPreview({
  title,
  body,
  ledRgb,
  className = "",
  caption = "Preview",
  layout = "stacked",
}) {
  const { r = 40, g = 44, b = 52 } = ledRgb || {};
  const glow = `0 0 28px rgba(${r},${g},${b},0.85)`;
  const led = <div className="simple-band-led" style={{ background: `rgb(${r},${g},${b})`, boxShadow: glow }} />;
  const msg = (
    <div className="simple-band-msg">
      {title ? <div className="simple-band-title">{title}</div> : <div className="simple-band-title muted">No message</div>}
      {body ? <div className="simple-band-body">{body}</div> : null}
    </div>
  );

  if (layout === "split") {
    return (
      <div className={`simple-band simple-band--split ${className}`.trim()}>
        <div className="simple-band-split-row">
          <div className="simple-band-bezel simple-band-bezel--compact">
            <div className="simple-band-screen simple-band-screen--compact" style={{ boxShadow: `inset 0 0 28px rgba(${r},${g},${b},0.22)` }}>
              {led}
            </div>
          </div>
          <div className="simple-band-msg-panel">{msg}</div>
        </div>
        {caption ? <span className="simple-band-caption">{caption}</span> : null}
      </div>
    );
  }

  return (
    <div className={`simple-band ${className}`.trim()}>
      <div className="simple-band-bezel">
        <div className="simple-band-screen" style={{ boxShadow: `inset 0 0 40px rgba(${r},${g},${b},0.25)` }}>
          {led}
          {msg}
        </div>
      </div>
      {caption ? <span className="simple-band-caption">{caption}</span> : null}
    </div>
  );
}
