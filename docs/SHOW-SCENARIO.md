# Show Scenario Contract (v1)

This contract defines how the Cloud Controller publishes a scenario to Operator Show Control.

## Version

- `schemaVersion`: `"aetherfield.showScenario.v1"`

## Top-Level Shape

```json
{
  "schemaVersion": "aetherfield.showScenario.v1",
  "metadata": {},
  "venue": {},
  "interactions": {},
  "timeline": {},
  "runbook": {},
  "kpis": {},
  "notes": []
}
```

## Metadata

- `scenarioId` (string)
- `name` (string)
- `createdAt` (ISO string)
- `createdBy` (string, optional)
- `durationMinutes` (number)

## Venue

- `zones`: array of
  - `id` (string)
  - `name` (string)
  - `capacity` (number)
  - `color` (string, hex)
  - `active` (boolean)
  - `nodeCount` (number)
- `totals`:
  - `capacity`
  - `nodes`
  - `activeZones`

## Interactions

- `rules`: array of
  - `id`
  - `name`
  - `active`
  - `targetZoneIds`
  - `maxInteractions`
  - `cooldownMinutes`
  - `conditionCount`
  - `priority`

## Timeline

- `bucketSeconds` (number)
- `buckets`: array of
  - `startSec`
  - `endSec`
  - `interactions`
  - `byRule` (record of rule name -> interaction count)

## Runbook

- `cues`: array of
  - `id`
  - `timeSec`
  - `label`
  - `zoneIds`
  - `sourceRuleId` (optional)
  - `color` `{ r, g, b }`
  - `mode` (number)
  - `rate` (number)
  - `note` (optional)

## KPIs

- `totalFans`
- `totalInteractions`
- `totalBudgetBlocked`
- `totalUpliftRevenue`
- `totalActivationCost`
- `roa`
- `revenuePerInteraction`

## Compatibility Rules

- Unknown fields should be ignored by importers.
- Missing optional fields should fallback to safe defaults.
- If `schemaVersion` is unknown, importer should reject with a clear error.
