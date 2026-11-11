/**
 * All user-facing wording in one place.
 *
 * Forked from traitors-registration, which selects between event presets at
 * build time. This deployment serves exactly one product — the Aura Tag demo
 * kit — so the presets are gone and this is just the copy. Overridable by env
 * where a specific demo wants different wording (NEXT_PUBLIC_EVENT_NAME etc.).
 */

export const EVENT = {
  key: "aetherfield",
  name: process.env.NEXT_PUBLIC_EVENT_NAME || "Aetherfield",
  tagline:
    process.env.NEXT_PUBLIC_EVENT_TAGLINE ||
    "Aura Tag registration. Scan the code on your Tag to link it to you.",
  logo: process.env.NEXT_PUBLIC_EVENT_LOGO || "/aura-registration/aetherfield-logo.svg",
  logoAlt: "Aetherfield",
  description: "Link your Aura Tag to your name.",
  copy: {
    title: "Link your Aura Tag",
    noDevice:
      "Scan the QR code on your Aura Tag to open this page with your device linked.",
    successTitle: "You're linked",
    successLede1: "Check your phone —",
    successLede2: "we've sent you a message.",
    submit: "Link my Tag",
    submitting: "Linking…",
    whatsappCta: "Continue on WhatsApp",
    whatsappNote:
      "Send the message that appears and we'll reach you there instead of by text.",
  },
};

/**
 * The welcome SMS. ${name} is the guest's first name, ${id} the Tag's id.
 * Says the two things a guest must know: it worked, and the data expires.
 */
export function welcomeMessage(name: string, id: string): string {
  return (
    `Hi ${name} — your Aura Tag (${id}) is now linked to you. ` +
    `This is a live technology demo: your name and number are deleted ` +
    `automatically after 30 minutes. — Aetherfield`
  );
}
