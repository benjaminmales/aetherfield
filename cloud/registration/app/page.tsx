import Link from "next/link";
import { EVENT } from "@/lib/event";

export default function Home() {
  return (
    <main className="card">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="logo" src={EVENT.logo} alt={EVENT.logoAlt} />
      <h1>{EVENT.name}</h1>
      <p className="disclaimer">
        {EVENT.tagline}
        <br />
        <br />
        <Link href="/qr" style={{ color: "var(--gold)" }}>
          Print QR codes &rarr;
        </Link>
      </p>
    </main>
  );
}
