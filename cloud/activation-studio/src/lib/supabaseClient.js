import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * A truthiness check is not enough here. A placeholder value in .env.local
 * (`VITE_SUPABASE_URL=...`) is truthy, so createClient() runs and throws
 * "Invalid URL" at module scope — which kills the whole module graph before
 * React mounts and renders a blank white page with nothing on screen.
 *
 * An ABSENT value degrades gracefully to the "add these vars" panel in App.
 * A MALFORMED one should do the same, not take the app down.
 */
function usableUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const urlOk = usableUrl(supabaseUrl);
const keyOk = Boolean(supabaseAnonKey) && String(supabaseAnonKey).length > 20;

if (supabaseUrl && !urlOk) {
  console.warn(
    `[supabase] VITE_SUPABASE_URL is set but not a valid URL (${JSON.stringify(
      supabaseUrl,
    )}). Treating Supabase as unconfigured.`,
  );
}
if (supabaseAnonKey && !keyOk) {
  console.warn("[supabase] VITE_SUPABASE_ANON_KEY is set but looks like a placeholder.");
}

export const supabaseConfigured = urlOk && keyOk;

export const supabase = supabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null;
