# Aura Marker — firmware

⚠ GAP: specified, not built.

A fixed anchor placed at a point of interest (bar, stage, exhibit). USB
powered, listens continuously, and reports which wearables are near it and
how strongly it hears them. That turns "where is everyone" into "who is at
this object", which is something we can actually measure.

Hardware: XIAO nRF54L15 with an external antenna on u.FL
(`antenna_external = true` in the band config). A directional antenna shapes
the zone.

Uplink: `NODE_RELAY` (msgid 0x05) to the nearest Aura Link, from the node
address range 0x0100–0x01FF.
