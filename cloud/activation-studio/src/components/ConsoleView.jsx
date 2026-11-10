import { useEffect, useMemo, useRef, useState } from "react";
import "./ConsoleView.css";

// Live "Console" run view for the demo. Self-contained: all data is simulated
// in-browser so it drops into the Vite app and runs with no backend. Later this
// same layout can be fed by the real activation sim / gateway telemetry.

const COL = {
  orange: "#ff7a1a", orange2: "#ff9d4d", good: "#3ecf8e",
  med: "#ffb02e", busy: "#ff5630", violet: "#a78bfa",
};

const ZONES = [
  { id: "sahara", name: "Sahara", x: 33, y: 40, r: 150, col: COL.orange, state: "HIGH", sc: COL.busy, guests: 2140, density: 92, dwell: 22, heat: 36 },
  { id: "mojave", name: "Mojave", x: 70, y: 36, r: 120, col: COL.med, state: "FILLING", sc: COL.med, guests: 1180, density: 64, dwell: 15, heat: 31 },
  { id: "gobi", name: "Gobi", x: 78, y: 64, r: 105, col: COL.good, state: "CLEAR", sc: COL.good, guests: 640, density: 38, dwell: 12, heat: 28 },
  { id: "outdoor", name: "Outdoor", x: 22, y: 70, r: 100, col: COL.good, state: "CLEAR", sc: COL.good, guests: 520, density: 31, dwell: 11, heat: 27 },
  { id: "vip", name: "VIP Rose", x: 48, y: 22, r: 90, col: COL.violet, state: "STEADY", sc: COL.violet, guests: 310, density: 44, dwell: 28, heat: 29 },
  { id: "main", name: "Main Stage", x: 52, y: 68, r: 150, col: COL.busy, state: "HIGH", sc: COL.busy, guests: 3820, density: 96, dwell: 18, heat: 34 },
];

const ACTIONS = {
  sahara: [["Cool down · misting", COL.orange, "214 guests"], ["Water reminder", COL.busy, "now"], ["Photo moment · golden hour", COL.med, "queued 19:40"]],
  main: [["Crowd surge watch", COL.busy, "armed"], ["Get-home prompt", COL.med, "curfew −20m"], ["Merch drop", COL.good, "20:00"]],
  mojave: [["Head to Outdoor", COL.med, "set starts"], ["Shade nudge", COL.orange, "96 guests"]],
  gobi: [["Chill-out playlist", COL.good, "live"]],
  outdoor: [["Golden hour photo", COL.med, "queued"]],
  vip: [["VIP welcome", COL.violet, "on entry"], ["Frosé nudge", COL.good, "dwell 5m"]],
};

const GATEWAYS = [
  ["GW-01", "Sahara", COL.busy, 54], ["GW-02", "Mojave", COL.med, 61],
  ["GW-03", "Gobi", COL.good, 58], ["GW-04", "Outdoor", COL.good, 66],
  ["GW-05", "VIP Rose", COL.violet, 59], ["GW-06", "Main N", COL.busy, 52],
  ["GW-07", "Main S", COL.med, 63], ["GW-08", "Ferris", COL.good, 60],
];

const FEED = [
  [COL.orange, "Sahara", (n) => `“Beat the heat 💧” sent to ${n} guests`],
  [COL.busy, "Main Stage", () => "density HIGH → surge watch armed"],
  [COL.good, "Rose Garden", (n) => `Frosé nudge → ${n} guests`],
  [COL.med, "Gobi", () => "wristbands glow amber · sunset cue"],
  [COL.violet, "VIP", (n) => `welcome sent · ${n} entries`],
  [COL.med, "Mojave", (n) => `head-to-Outdoor nudge · ${n} guests`],
  [COL.orange, "Sahara", (n) => `water reminder → ${n} guests`],
  [COL.good, "Outdoor", () => "golden-hour photo prompt queued"],
];

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const pad = (v) => String(v).padStart(2, "0");
const rnd = (n) => Math.floor(Math.random() * n);

export default function ConsoleView() {
  const [selId, setSelId] = useState("sahara");
  const [zones, setZones] = useState(ZONES);
  const [feed, setFeed] = useState([]);
  const [gwState, setGwState] = useState(() => GATEWAYS.map((g) => ({ strength: 3, db: g[3] })));
  const [onsite, setOnsite] = useState(6240);
  const minsRef = useRef(14 * 60 + 22);
  const cycRef = useRef(6);
  const [clock, setClock] = useState("LIVE · 14:22 · cycle 6/12");
  const feedId = useRef(0);

  const stamp = () => `${pad(Math.floor(minsRef.current / 60))}:${pad(minsRef.current % 60)}:${pad(rnd(60))}`;

  // streaming trigger feed
  useEffect(() => {
    const push = () => {
      const t = FEED[rnd(FEED.length)];
      const n = rnd(240) + 8;
      setFeed((f) => [{ id: feedId.current++, tm: stamp(), col: t[0], zn: t[1], tx: t[2](n) }, ...f].slice(0, 6));
    };
    for (let i = 0; i < 5; i++) push();
    const iv = setInterval(push, 2100);
    return () => clearInterval(iv);
  }, []);

  // gateway signal jitter
  useEffect(() => {
    const iv = setInterval(() => {
      setGwState(GATEWAYS.map((g) => ({
        strength: Math.max(0, Math.min(4, Math.round((75 - g[3]) / 6) + (Math.random() < 0.5 ? 0 : 1))),
        db: g[3] + Math.round((Math.random() - 0.5) * 4),
      })));
    }, 1400);
    return () => clearInterval(iv);
  }, []);

  // clock + on-site drift
  useEffect(() => {
    const iv = setInterval(() => {
      minsRef.current = (minsRef.current + 1) % (24 * 60);
      if (minsRef.current % 120 === 0) cycRef.current = (cycRef.current % 12) + 1;
      setClock(`LIVE · ${pad(Math.floor(minsRef.current / 60))}:${pad(minsRef.current % 60)} · cycle ${cycRef.current}/12`);
      setOnsite((c) => c + Math.round((Math.random() - 0.4) * 40));
    }, 3000);
    return () => clearInterval(iv);
  }, []);

  // gentle live drift of zone stats
  useEffect(() => {
    const iv = setInterval(() => {
      setZones((zs) => zs.map((z) => ({
        ...z,
        guests: Math.max(120, z.guests + Math.round((Math.random() - 0.45) * 60)),
        density: Math.max(10, Math.min(99, z.density + Math.round((Math.random() - 0.5) * 4))),
      })));
    }, 2500);
    return () => clearInterval(iv);
  }, []);

  const sel = useMemo(() => zones.find((z) => z.id === selId) || zones[0], [zones, selId]);
  const acts = ACTIONS[sel.id] || [];

  return (
    <div className="cv">
      <div className="cv-wrap">
        <div className="cv-bar">
          <div className="cv-brand"><span className="cv-dot" /><b>ÆTHERFIELD</b><span>Event Manager</span></div>
          <div className="cv-nav">
            <div className="cv-tab active">Run</div>
            <div className="cv-tab">Setup <span className="lk">🔒</span></div>
            <div className="cv-tab">Rules <span className="lk">🔒</span></div>
          </div>
          <div className="cv-live"><span className="d" />{clock}</div>
        </div>

        <div className="cv-body">
          {/* left rail */}
          <div className="cv-rail">
            <div className="h">RUN</div>
            <div className="cv-it on">Live map</div>
            <div className="cv-it">Zones</div>
            <div className="cv-it">Trigger feed</div>
            <div className="cv-it">Guests</div>
            <div className="cv-it">Gateways</div>
            <div className="cv-foot">
              <div className="g"><span className="cv-gdot" />All systems live</div>
              <div className="s">{onsite.toLocaleString()} bands · 8 gateways</div>
            </div>
          </div>

          {/* center */}
          <div className="cv-center">
            <div className="cv-card cv-mapcard">
              <div className="cv-ch"><div className="t">Live map <span className="s">· Coachella · simulated crowd</span></div></div>
              <div className="cv-map">
                {zones.map((z) => (
                  <div key={"b" + z.id} className="cv-bloom" style={{
                    left: `calc(${z.x}% - ${z.r / 2}px)`, top: `calc(${z.y}% - ${z.r / 2}px)`,
                    width: z.r, height: z.r,
                    background: `radial-gradient(circle, ${z.col} 0%, ${hexA(z.col, 0)} 70%)`,
                    animationDelay: `${(z.x % 5)}s`,
                  }} />
                ))}
                {zones.map((z) => (
                  <div key={"r" + z.id} className="cv-zring" style={{
                    left: `${z.x}%`, top: `${z.y}%`, width: z.r * 0.9, height: z.r * 0.9,
                    border: `1px solid ${hexA(z.col, 0.5)}`, background: hexA(z.col, 0.05),
                  }} />
                ))}
                {zones.map((z) => (
                  <div key={"l" + z.id} className={"cv-zlabel" + (z.id === selId ? " sel" : "")}
                    style={{ left: `${z.x}%`, top: `${z.y}%` }} onClick={() => setSelId(z.id)}>
                    <span className="cv-zd" style={{ background: z.col }} />{z.name}
                  </div>
                ))}
              </div>
              <div className="cv-legend"><b>Heat = live crowd density from gateway signal.</b> One bloom per zone · click a zone to open its live insight →</div>
            </div>

            <div className="cv-card">
              <div className="cv-ch">
                <div className="t">Live activity <span className="s" style={{ marginLeft: 6 }}><span className="cv-streamdot" />streaming</span></div>
                <div className="s">214/min</div>
              </div>
              <div className="cv-actwrap">
                {feed.map((r) => (
                  <div key={r.id} className="cv-frow">
                    <span className="tm">{r.tm}</span>
                    <span className="cv-zd" style={{ background: r.col, flex: "0 0 auto" }} />
                    <span className="zn">{r.zn}</span>
                    <span className="tx">{r.tx}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* right */}
          <div className="cv-right">
            <div className="cv-card cv-insight">
              <div className="cv-ih">
                <div>
                  <div className="name"><span className="cv-zd" style={{ width: 9, height: 9, background: sel.col }} /><h2>Zone · {sel.name}</h2></div>
                  <div className="sub">selected · live readout</div>
                </div>
                <div className="cv-state" style={{ color: sel.sc, borderColor: sel.sc, background: hexA(sel.sc, 0.14) }}>{sel.state}</div>
              </div>
              <div className="cv-tiles">
                <Tile k="Guests" v={sel.guests.toLocaleString()} />
                <Tile k="Dwell" v={`${sel.dwell} min`} />
                <Tile k="Heat" v={`${sel.heat} °C`} color={sel.heat > 33 ? COL.busy : undefined} />
                <Tile k="Density" v={`${sel.density}%`} color={sel.density > 85 ? COL.busy : undefined} />
                <Tile k="Msgs sent" v={Math.round(sel.guests * 0.1)} color={COL.orange2} />
                <Tile k="Actions" v={`${acts.length} live`} color={COL.good} />
              </div>
              <div className="cv-afh">ACTIONS FIRING NOW</div>
              {acts.map((a, i) => (
                <div key={i} className="cv-arow">
                  <span className="bar" style={{ background: a[1] }} />
                  <span className="cv-zd" style={{ background: a[1] }} />
                  <span className="an">{a[0]}</span>
                  <span className="am">{a[2]}</span>
                </div>
              ))}
            </div>

            <div className="cv-card">
              <div className="cv-ch"><div className="t">Gateways <span className="s">· 8 live</span></div><div className="s">Load ↻</div></div>
              <div className="cv-gwgrid">
                {GATEWAYS.map((g, i) => (
                  <div key={g[0]} className="cv-chip">
                    <div className="top"><span className="cv-cd" style={{ background: g[2] }} /><span className="nm">{g[0]}</span></div>
                    <div className="zn">{g[1]}</div>
                    <div className="cv-bars">
                      {[0, 1, 2, 3].map((b) => (
                        <i key={b} style={{ height: 7 + b * 6, background: b < gwState[i].strength ? g[2] : "var(--line2)" }} />
                      ))}
                    </div>
                    <div className="db">−{gwState[i].db} dBm</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="cv-note">Live preview · all data simulated in-browser. Console run view for the Aetherfield demo.</div>
    </div>
  );
}

function Tile({ k, v, color }) {
  return (
    <div className="cv-tile">
      <div className="k">{k}</div>
      <div className="v" style={color ? { color } : undefined}>{v}</div>
    </div>
  );
}
