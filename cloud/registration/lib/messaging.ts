/**
 * Twilio messaging: WhatsApp first, SMS fallback.
 * Raw REST (no SDK) — same pattern as aura-registration.
 */

export type SendResult = {
  channel: "whatsapp" | "sms" | "dry-run";
  sid?: string;
  error?: string;
};

function env(name: string): string {
  return (process.env[name] || "").trim();
}

async function twilioSend(from: string, to: string, body: string): Promise<string> {
  const sid = env("TWILIO_ACCOUNT_SID");
  const token = env("TWILIO_AUTH_TOKEN");
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || `Twilio HTTP ${res.status}`);
  }
  const data = (await res.json()) as { sid?: string };
  return data.sid ?? "";
}

/**
 * Send to a guest: try WhatsApp, fall back to SMS.
 * `to` is E.164 (e.g. +447700900123).
 *
 * `opts.channel: "sms"` skips WhatsApp entirely. Use for business-initiated
 * messages to guests who may not have opened a WhatsApp 24h window yet —
 * Twilio ACCEPTS those sends and only fails at delivery (error 63016), so
 * the fallback here never fires and the guest silently gets nothing.
 */
export async function sendMessage(
  to: string,
  body: string,
  opts?: { channel?: "sms" | "auto" }
): Promise<SendResult> {
  const hasCreds = env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN");
  if (!hasCreds) {
    console.warn("[messaging] Twilio env missing; dry run:", to, body.slice(0, 80));
    return { channel: "dry-run" };
  }

  const waFrom = env("TWILIO_WHATSAPP_NUMBER"); // e.g. whatsapp:+14155238886
  const smsFrom = env("TWILIO_PHONE_NUMBER");

  if (waFrom && opts?.channel !== "sms") {
    try {
      const sid = await twilioSend(waFrom, `whatsapp:${to}`, body);
      return { channel: "whatsapp", sid };
    } catch (e) {
      console.warn(
        "[messaging] WhatsApp failed, falling back to SMS:",
        e instanceof Error ? e.message : e
      );
    }
  }

  if (smsFrom) {
    try {
      const sid = await twilioSend(smsFrom, to, body);
      return { channel: "sms", sid };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error("[messaging] SMS failed:", error);
      return { channel: "sms", error };
    }
  }

  return { channel: "sms", error: "No sender configured (TWILIO_WHATSAPP_NUMBER / TWILIO_PHONE_NUMBER)" };
}
