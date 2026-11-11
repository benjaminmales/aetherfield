/**
 * Shared-secret auth for the machine endpoints.
 *
 * /api/registrations hands out names and phone numbers, and /api/action sends
 * texts on Aetherfield's Twilio account, so neither can be open to the
 * internet. The one legitimate caller is the Demo Server on the client's
 * laptop (server/lib/cloud.js), which sends:
 *
 *     Authorization: Bearer <CLOUD_API_TOKEN>
 *
 * FAIL CLOSED: if CLOUD_API_TOKEN is not set on a deployed instance, these
 * endpoints refuse rather than default to open — a misconfigured deployment
 * must never become a free SMS gateway. Local dev (no VERCEL env) runs open
 * so `npm run dev` works without ceremony.
 */

import { NextRequest, NextResponse } from "next/server";

export function requireToken(req: NextRequest): NextResponse | null {
  const token = (process.env.CLOUD_API_TOKEN || "").trim();
  if (!token) {
    if (!process.env.VERCEL) return null; // local dev
    return NextResponse.json(
      { error: "CLOUD_API_TOKEN is not configured on this deployment" },
      { status: 503 }
    );
  }
  const auth = (req.headers.get("authorization") || "").trim();
  if (auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
