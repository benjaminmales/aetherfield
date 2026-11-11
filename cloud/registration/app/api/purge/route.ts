import { NextResponse } from "next/server";
import { purgeExpired } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/purge — sweep expired guests. Purging also happens lazily on every
 * API call; this exists so idle periods can't leave personal data lingering
 * (wired to Vercel Cron in vercel.json).
 */
export async function GET() {
  try {
    const deleted = await purgeExpired();
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    console.error("Purge API error:", e);
    return NextResponse.json({ error: "Purge failed" }, { status: 500 });
  }
}
