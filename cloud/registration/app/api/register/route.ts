import { NextRequest, NextResponse } from "next/server";
import { normalizeCell, normalizeDeviceId, upsertRegistration } from "@/lib/db";
import { sendMessage } from "@/lib/messaging";
import { welcomeMessage } from "@/lib/event";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { deviceId: rawDeviceId, name, cell } = body as Record<string, unknown>;

    if (!rawDeviceId || typeof rawDeviceId !== "string") {
      return NextResponse.json({ error: "Missing or invalid device ID" }, { status: 400 });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (!cell || typeof cell !== "string" || !cell.trim()) {
      return NextResponse.json({ error: "Cell number is required" }, { status: 400 });
    }

    const deviceId = normalizeDeviceId(rawDeviceId);
    if (!/^[0-9A-F]{4}$/.test(deviceId)) {
      return NextResponse.json({ error: "Invalid device ID" }, { status: 400 });
    }

    const cellClean = normalizeCell(cell);
    if (!/^\+\d{10,15}$/.test(cellClean)) {
      return NextResponse.json(
        { error: "Please enter a valid mobile number (e.g. +44 7700 900123)" },
        { status: 400 }
      );
    }
    const registration = await upsertRegistration(deviceId, name.trim(), cellClean);

    // Welcome message — SMS on purpose: a WhatsApp business-initiated message
    // to a guest with no open 24h window is accepted by Twilio but never
    // delivered (63016), and the fallback can't catch that. The success page
    // then offers a WhatsApp tap-through that opens the window for the rest.
    const firstName = name.trim().split(/\s+/)[0];
    const send = await sendMessage(cellClean, welcomeMessage(firstName, deviceId), {
      channel: "sms",
    });

    // wa.me link so the guest can open the WhatsApp 24h window with one tap.
    const waDigits = (process.env.TWILIO_WHATSAPP_NUMBER || "")
      .replace(/^whatsapp:/, "")
      .replace(/[^\d]/g, "");
    const waText = encodeURIComponent("Hi Aetherfield — message me here.");
    const whatsappLink = waDigits ? `https://wa.me/${waDigits}?text=${waText}` : null;

    return NextResponse.json({
      ...registration,
      messageChannel: send.channel,
      whatsappLink,
      expiresAt: registration.expires_at,
    });
  } catch (e) {
    console.error("Register API error:", e);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
