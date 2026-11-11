import { NextRequest, NextResponse } from "next/server";
import { deleteAllRegistrations } from "@/lib/db";
import { requireToken } from "@/lib/auth";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * POST /api/reset — hard-delete ALL registrations now, for a fresh demo run.
 * Auth: Authorization: Bearer <CLOUD_API_TOKEN>
 */
export async function POST(req: NextRequest) {
  const denied = requireToken(req);
  if (denied) return denied;
  try {
    const deleted = await deleteAllRegistrations();
    return NextResponse.json({ ok: true, deleted }, { headers: CORS });
  } catch (e) {
    console.error("Reset API error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reset failed" },
      { status: 500, headers: CORS }
    );
  }
}
