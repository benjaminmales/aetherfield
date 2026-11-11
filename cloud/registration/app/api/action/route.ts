/**
 * POST /api/action — message one guest, addressed by their Aura Tag id.
 *
 * This is the endpoint the Demo Server calls (server/lib/cloud.js). That
 * server runs on the venue LAN and knows only radio addresses: it has never
 * held a name or a number and is not going to start. So it posts an ADDRESS
 * and a MESSAGE here, and this side — which owns the guest table — resolves
 * the contact and sends.
 *
 *   POST { device_id: "4C51", message: "..." }
 *   Authorization: Bearer <CLOUD_API_TOKEN>
 *
 * Token-locked and rate-capped: this endpoint spends Aetherfield's Twilio
 * money. The cap is per serverless instance, so it is a brake, not an
 * accounting system — its job is to turn "a bug texts someone 500 times"
 * into "a bug texts someone a few times and then errors loudly".
 */

import { NextRequest, NextResponse } from "next/server";
import { getRegistrationByDeviceId, normalizeDeviceId } from "@/lib/db";
import { sendMessage } from "@/lib/messaging";
import { requireToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/* Sliding-window send cap (per instance). */
const RATE_MAX = parseInt(process.env.ACTION_RATE_MAX || "15", 10);
const RATE_WINDOW_MS = 60_000;
let sends: number[] = [];
function rateLimited(): boolean {
  const now = Date.now();
  sends = sends.filter((t) => now - t < RATE_WINDOW_MS);
  if (sends.length >= RATE_MAX) return true;
  sends.push(now);
  return false;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  const denied = requireToken(req);
  if (denied) return denied;
  try {
    const p = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const rawId = str(p.device_id) || str(p.deviceId) || str(p.id);
    if (!rawId) return json({ error: "Missing device_id" }, 400);
    const deviceId = normalizeDeviceId(rawId);

    const text = str(p.message) || str(p.text) || str(p.body);
    if (!text) return json({ error: "No message text (set `message`)" }, 400);

    const reg = await getRegistrationByDeviceId(deviceId);
    if (!reg) return json({ error: "No registration for this device", deviceId }, 404);
    if (!reg.cell?.trim()) return json({ error: "Registration has no phone number", deviceId }, 400);

    if (rateLimited()) {
      return json({ error: `Rate limit: max ${RATE_MAX} messages/minute`, deviceId }, 429);
    }

    /*
     * SMS, not WhatsApp. This is business-initiated to someone who registered
     * minutes ago and has never messaged us, so there is no open WhatsApp
     * 24-hour window. Twilio ACCEPTS those sends and only fails at delivery
     * (error 63016), which means the fallback in lib/messaging.ts never fires
     * and the guest silently gets nothing — the worst possible failure in
     * front of an audience.
     */
    const result = await sendMessage(reg.cell, text, { channel: "sms" });

    if (result.channel === "dry-run") {
      // No Twilio env. Say so plainly rather than reporting a send: the
      // caller's console renders this as DRY RUN so a rehearsal can never be
      // mistaken for the real thing.
      return json({ ok: true, dryRun: true, deviceId, preview: text.slice(0, 160) });
    }
    if (result.error) {
      return json({ error: result.error, deviceId, channel: result.channel }, 502);
    }
    return json({ ok: true, deviceId, sid: result.sid, channel: result.channel });
  } catch (e) {
    console.error("Action API error:", e);
    return json({ error: e instanceof Error ? e.message : "Action failed" }, 500);
  }
}
