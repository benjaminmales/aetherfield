"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { EVENT } from "@/lib/event";

function Logo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="logo"
      src={EVENT.logo}
      alt={EVENT.logoAlt}
      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
    />
  );
}

function RegisterForm() {
  const searchParams = useSearchParams();
  const deviceParam = (searchParams.get("d") ?? "").toUpperCase();
  const [name, setName] = useState("");
  const [cell, setCell] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [whatsappLink, setWhatsappLink] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: deviceParam, name, cell }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Registration failed.");
        return;
      }
      setStatus("success");
      setMessage("");
      setWhatsappLink(data.whatsappLink ?? null);
    } catch {
      setStatus("error");
      setMessage("Network error. Please try again.");
    }
  }

  if (!deviceParam) {
    return (
      <main className="card">
        <Logo />
        <h1>{EVENT.copy.title}</h1>
        <p className="disclaimer">{EVENT.copy.noDevice}</p>
      </main>
    );
  }

  if (status === "success") {
    return (
      <main className="card">
        <Logo />
        <h1 style={{ marginTop: "8rem" }}>{EVENT.copy.successTitle}</h1>
        <p className="lede">
          {EVENT.copy.successLede1}
          <br />
          {EVENT.copy.successLede2}
        </p>
        {whatsappLink && (
          <>
            <a className="primary" href={whatsappLink} style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: "2rem" }}>
              {EVENT.copy.whatsappCta}
            </a>
            <p className="disclaimer">{EVENT.copy.whatsappNote}</p>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="card">
      <Logo />
      <h1>{EVENT.copy.title}</h1>
      <form onSubmit={handleSubmit}>
        <label>
          <span>Name/Nickname</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
          />
        </label>
        <label>
          <span>Mobile number</span>
          <input
            type="tel"
            value={cell}
            onChange={(e) => setCell(e.target.value)}
            required
            autoComplete="tel"
            placeholder="+44 7700 900123"
          />
        </label>
        {message && <p className="msg error">{message}</p>}
        <button className="primary" type="submit" disabled={status === "loading"}>
          {status === "loading" ? EVENT.copy.submitting : EVENT.copy.submit}
        </button>
      </form>
      <p className="disclaimer">
        This is a technology demonstration. Your name and number are used only
        to send you messages during this demo (WhatsApp or SMS) and are
        automatically deleted 30 minutes after registration. Nothing is stored,
        shared, or used for any other purpose. By registering you consent to
        this use.
      </p>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<p style={{ padding: "2rem", textAlign: "center" }}>Loading…</p>}>
      <RegisterForm />
    </Suspense>
  );
}
