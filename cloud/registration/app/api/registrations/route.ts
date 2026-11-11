import { NextRequest, NextResponse } from "next/server";
import { listRegistrations } from "@/lib/db";
import { requireToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/registrations — the full roster, names and numbers included.
 * PII, so token-locked: the only caller is the Demo Server (lib/cloud.js),
 * which strips the phone number before anything reaches a browser.
 */
export async function GET(req: NextRequest) {
  const denied = requireToken(req);
  if (denied) return denied;
  try {
    const rows = await listRegistrations();
    return NextResponse.json(rows);
  } catch (e) {
    console.error("Registrations API error:", e);
    return NextResponse.json({ error: "Failed to list registrations" }, { status: 500 });
  }
}
