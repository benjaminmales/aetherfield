/** URL opened when a placeholder pairing QR is scanned.
 *  Opens /pair with virtualId, kind, and projectId so the
 *  two-QR handshake page can complete the device binding. */
export function buildPairingHoldUrl(kind, virtualId, pageId) {
  if (typeof window === "undefined") return "";
  const u = new URL("/pair", window.location.origin);
  u.searchParams.set("kind", kind);
  u.searchParams.set("virtualId", virtualId);
  if (pageId) u.searchParams.set("projectId", pageId);
  return u.href;
}
