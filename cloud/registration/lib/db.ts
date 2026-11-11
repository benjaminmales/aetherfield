import { createClient, SupabaseClient } from "@supabase/supabase-js";

const TABLE = "aura_registrations";

let _supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!
    );
  }
  return _supabase;
}

export type Registration = {
  id: number;
  device_id: string;
  name: string;
  cell: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

/** Minutes a guest's data lives before hard deletion. */
export const SESSION_MINUTES = parseInt(process.env.SESSION_MINUTES || "30", 10);

/** Aura Tag ids are the 16-bit radio address as 4 uppercase hex chars ('4C51'). */
export function normalizeDeviceId(raw: string): string {
  return raw.trim().replace(/^0x/i, "").toUpperCase().padStart(4, "0");
}

/**
 * Normalise a phone number to E.164 so '07700 900123', '447700900123' and
 * '+447700900123' all become '+447700900123' (Twilio's From format).
 * UK is the assumed country for numbers entered in national format.
 */
export function normalizeCell(raw: string): string {
  let c = raw.trim().replace(/[\s().-]/g, "");
  if (c.startsWith("00")) c = "+" + c.slice(2); // international 00 prefix
  else if (c.startsWith("07")) c = "+44" + c.slice(1); // UK national mobile
  else if (c.startsWith("0")) c = "+44" + c.slice(1); // other UK national
  else if (/^44\d{9,}$/.test(c)) c = "+" + c; // 44… missing the +
  else if (/^\d{10,}$/.test(c)) c = "+" + c; // bare international digits
  return c;
}

/**
 * PRIVACY: hard-delete expired guests. Called lazily before every read/write
 * so personal data never outlives the session window.
 */
export async function purgeExpired(): Promise<number> {
  const { data, error } = await db()
    .from(TABLE)
    .delete()
    .lt("expires_at", new Date().toISOString())
    .select("id");
  if (error) console.error("[db] purge failed:", error.message);
  return data?.length ?? 0;
}

export async function upsertRegistration(
  deviceId: string,
  name: string,
  cell: string
): Promise<Registration> {
  await purgeExpired();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MINUTES * 60_000);
  const { data, error } = await db()
    .from(TABLE)
    .upsert(
      {
        device_id: deviceId,
        name,
        cell,
        expires_at: expires.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: "device_id" }
    )
    .select()
    .single();
  if (error) throw new Error(`Registration upsert failed: ${error.message}`);
  return data as Registration;
}

export async function getRegistrationByDeviceId(
  deviceId: string
): Promise<Registration | null> {
  await purgeExpired();
  const { data } = await db()
    .from(TABLE)
    .select("*")
    .eq("device_id", deviceId)
    .gte("expires_at", new Date().toISOString())
    .limit(1)
    .maybeSingle();
  return (data as Registration) ?? null;
}

export async function listRegistrations(): Promise<Registration[]> {
  await purgeExpired();
  const { data, error } = await db()
    .from(TABLE)
    .select("*")
    .gte("expires_at", new Date().toISOString())
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`List registrations failed: ${error.message}`);
  return (data ?? []) as Registration[];
}

/** Manual reset: wipe ALL guest data immediately (between demo runs). */
export async function deleteAllRegistrations(): Promise<number> {
  const { data, error } = await db()
    .from(TABLE)
    .delete()
    .neq("id", 0) // match everything
    .select("id");
  if (error) throw new Error(`Reset failed: ${error.message}`);
  return data?.length ?? 0;
}
