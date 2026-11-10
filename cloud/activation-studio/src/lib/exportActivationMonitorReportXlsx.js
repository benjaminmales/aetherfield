import { CONVERSION_ATTRIBUTION_WINDOW_SIM_MS } from "./simConversion";

/** @param {string} name */
function safeSheetName(name) {
  const x = String(name || "Sheet")
    .replace(/[[\]/\\?:*]/g, "-")
    .trim()
    .slice(0, 31);
  return x || "Sheet";
}

function formatHm(isoString) {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return "report";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  } catch {
    return "report";
  }
}

/**
 * Export rehearsal monitor data as an .xlsx workbook (downloads in-browser).
 *
 * @param {{
 *   generatedAt: Date;
 *   reportTitle?: string;
 *   venueLayerTitle: string;
 *   projectLayersCount: number | string;
 *   pushedAt?: string | null;
 *   summary: Record<string, string | number>;
 *   areaRows: Array<{
 *     name: string;
 *     uniqueEstimated: number;
 *     arrivals: number;
 *     dwellMinutes: number;
 *     avgDwellMin: number;
 *     repeatTouches: number;
 *     shareOfTraffic: number;
 *   }>;
 *   venueTotals?: {
 *     estimatedUniqueVenueWide: number;
 *     totalPresenceEvents: number;
 *     totalDwellSimMinutes: number;
 *     estimatedRepeatTouchesVenueWide: number;
 *     peakAttentionZoneLabel?: string;
 *     peakAttentionZoneDetail?: string;
 *   } | null;
 *   nodeMetaRows: Array<{
 *     rank: number;
 *     poiId: string;
 *     name: string;
 *     arrivals: number;
 *     dwellMinutes: number;
 *     uniqueEstimated: number;
 *     returnVisitsEst: number;
 *     avgDwellMinPerPresenceTouch: number;
 *     avgSimDwellMinPerUniqueEst: number;
 *     shareOfSampleTraffic: number;
 *     uniqueDevicesAtAnchor: number;
 *     triggersAtNode: number;
 *   }>;
 *   triggerRows: Array<{
 *     id: string;
 *     name: string;
 *     count: number;
 *     conversionGoals?: string | null;
 *     attributedVisits?: number | null;
 *     conversionRatePct?: number | null;
 *   }>;
 *   logRows: Array<{ simMinutes: number; message: string }>;
 * }} payload
 */
export async function downloadActivationMonitorReportXlsx(payload) {
  const { utils, writeFile } = await import("xlsx");

  const wb = utils.book_new();
  const {
    generatedAt,
    reportTitle,
    venueLayerTitle,
    projectLayersCount,
    pushedAt,
    summary,
    areaRows,
    venueTotals,
    nodeMetaRows,
    triggerRows,
    logRows,
  } = payload;

  const conversionAttribMinSim = Math.round(CONVERSION_ATTRIBUTION_WINDOW_SIM_MS / 60000);

  /** @type {(string | number)[][]} */
  const summaryAoA = [
    [reportTitle || "Activation monitor report (rehearsal playback)", ""],
    ["Generated", generatedAt.toISOString()],
    ["Venue layer", venueLayerTitle],
    ["Layers in project", projectLayersCount],
    ...(pushedAt ? [["Programme pushed at (stub)", pushedAt]] : []),
    ["", ""],
    ["Run & scenario (from rehearsal)", ""],
    ...Object.entries(summary).map(([k, v]) => [k, v]),
    ["", ""],
    [
      "Notes",
      "Synthetic rehearsal · dimensions match client reporting (presence, dwell, uniqueness, repeats); not field telemetry.",
    ],
    [
      "Reporting · experience nodes",
      "Anchored rehearsal samples per node (all devices monitored by UUID). Dwell here is simulated time-in-view; live deployments will sessionize discrete dwells (visit enter → backend completion rules). Unique visits & repeats are rehearsal saturation estimates. Triggers at node = programmable rule hit count (registered-eligible), constrained by cooldowns and programme targeting.",
    ],
    [
      "Reporting · rule conversion (rehearsal)",
      `Attributed goal visits · each rule credited separately when the visitor had a qualifying trigger from that rule; at most one per visitor ID per rule, within ${conversionAttribMinSim} minutes simulated time. Conversion rate capped at 100%. Synthetic follow-on samples inflate modest rehearsal visibility only.`,
    ],
  ];

  if (venueTotals) {
    summaryAoA.push(
      ["", ""],
      ["Venue-wide aggregates (areas · estimated)", ""],
      ["Estimated unique attendees (venue-wide)", venueTotals.estimatedUniqueVenueWide],
      ["Presence touches (venue-wide)", venueTotals.totalPresenceEvents],
      ["Dwell (simulated minutes · venue-wide)", venueTotals.totalDwellSimMinutes],
      ["Repeat touches (venue-wide)", venueTotals.estimatedRepeatTouchesVenueWide],
      ...(venueTotals.peakAttentionZoneLabel
        ? [
            [
              "Peak zone (presence touches)",
              `${venueTotals.peakAttentionZoneLabel} — ${venueTotals.peakAttentionZoneDetail || ""}`,
            ],
          ]
        : [])
    );
  }

  utils.book_append_sheet(wb, utils.aoa_to_sheet(summaryAoA), safeSheetName("Summary"));

  /** @type {(string | number)[][]} */
  const areasAoA = [
    [
      "Area / zone",
      "Unique visitors (est.)",
      "Presence touches",
      "Dwell (sim min)",
      "Avg dwell / visitor (min)",
      "Repeat touches (est.)",
      "Share of presence touches",
    ],
    ...(areaRows.length === 0
      ? [["—", "", "", "", "", "", "No area traffic yet · run from Scenario window"]]
      : areaRows.map((r) => [
          r.name,
          r.uniqueEstimated,
          r.arrivals,
          Number(r.dwellMinutes.toFixed(3)),
          r.avgDwellMin > 0 ? Number(r.avgDwellMin.toFixed(4)) : "—",
          r.repeatTouches,
          `${Math.round(r.shareOfTraffic * 100)}%`,
        ])),
  ];
  utils.book_append_sheet(wb, utils.aoa_to_sheet(areasAoA), safeSheetName("Areas"));

  /** @type {(string | number)[][]} */
  const nodesAoA = [
    [
      "Rank",
      "Experience node id",
      "Display name",
      "Presence touches (anchored)",
      "Dwell (simulated min)",
      "Unique visits (est.)",
      "Return visits (est.)",
      "Avg dwell / presence touch (sim min)",
      "Avg simulated dwell / unique visitor (est. min)",
      "Share of anchored samples",
      "Unique devices at anchor (rehearsal UUIDs)",
      "Triggers at node (rehearsal)",
    ],
    ...(nodeMetaRows.length === 0
      ? [["—", "", "", "", "", "", "", "", "", "", "", "No nodes on layer"]]
      : nodeMetaRows.map((r) => [
          r.rank,
          r.poiId,
          r.name,
          r.arrivals,
          Number(r.dwellMinutes.toFixed(3)),
          r.uniqueEstimated,
          r.returnVisitsEst,
          r.arrivals > 0 ? Number(r.avgDwellMinPerPresenceTouch.toFixed(4)) : "—",
          r.uniqueEstimated > 0 ? Number(r.avgSimDwellMinPerUniqueEst.toFixed(4)) : "—",
          `${Math.round(r.shareOfSampleTraffic * 100)}%`,
          r.uniqueDevicesAtAnchor ?? 0,
          r.triggersAtNode,
        ])),
  ];
  utils.book_append_sheet(wb, utils.aoa_to_sheet(nodesAoA), safeSheetName("Nodes meta"));

  /** @type {(string | number)[][]} */
  const trigAoA = [
    [
      "Rule / experience id",
      "Name",
      "Trigger count",
      "Conversion goal nodes",
      "Attributed arrivals (est.)",
      "Conversion rate %",
    ],
    ...(triggerRows.length === 0
      ? [["—", "", "", "", "", ""]]
      : triggerRows.map((r) => [
          r.id,
          r.name,
          r.count,
          r.conversionGoals ?? "—",
          r.attributedVisits != null ? Math.round(Number(r.attributedVisits)) : "—",
          r.conversionRatePct != null ? Number(r.conversionRatePct.toFixed(1)) : "—",
        ])),
  ];
  utils.book_append_sheet(wb, utils.aoa_to_sheet(trigAoA), safeSheetName("Triggers"));

  /** @type {(string | number)[][]} */
  const logAoA = [
    ["Sim elapsed (minutes)", "Message"],
    ...(logRows.length === 0
      ? [["—", "No log lines exported"]]
      : logRows.map((r) => [Number(r.simMinutes.toFixed(3)), r.message])),
  ];
  utils.book_append_sheet(wb, utils.aoa_to_sheet(logAoA), safeSheetName("Activity"));

  const stamp = formatHm(generatedAt.toISOString());
  writeFile(wb, `activation-rehearsal-report_${stamp}.xlsx`);
}
