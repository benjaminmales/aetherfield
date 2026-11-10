import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { buildPairingHoldUrl } from "../lib/pairingUrl";
import "./PairingQrPlaceholder.css";

/**
 * @param {{ kind: "node" | "gateway"; virtualId: string; pageId?: string; className?: string }} props
 */
export default function PairingQrPlaceholder({ kind, virtualId, pageId, className = "" }) {
  const [dataUrl, setDataUrl] = useState("");
  const ready = Boolean(virtualId && pageId);
  const targetUrl = useMemo(() => buildPairingHoldUrl(kind, virtualId, pageId), [kind, virtualId, pageId]);

  useEffect(() => {
    if (!virtualId || !targetUrl) return undefined;
    let cancelled = false;
    QRCode.toDataURL(targetUrl, {
      width: 176,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [targetUrl, virtualId]);

  if (!ready) {
    return (
      <div className={["pairing-qr", className].filter(Boolean).join(" ")}>
        <div className="pairing-qr-frame">
          <div className="pairing-qr-skel" aria-hidden>—</div>
        </div>
        <p className="pairing-qr-hint">
          Select or save this project first — a pairing code needs a saved project to link to.
        </p>
      </div>
    );
  }

  return (
    <div className={["pairing-qr", className].filter(Boolean).join(" ")}>
      <div className="pairing-qr-frame">
        {dataUrl ? (
          <img src={dataUrl} alt="Pairing QR code" width={176} height={176} className="pairing-qr-img" />
        ) : (
          <div className="pairing-qr-skel" aria-hidden>
            QR…
          </div>
        )}
      </div>
      <p className="pairing-qr-hint">
        Placeholder — opens a holding page until the registration app is ready. Payload:{" "}
        <code>{kind}</code> / <code>{virtualId}</code>
        {pageId ? (
          <>
            {" "}
            / <code>{pageId}</code>
          </>
        ) : null}
      </p>
      <a className="pairing-qr-link" href={targetUrl} target="_blank" rel="noreferrer">
        Open holding page
      </a>
    </div>
  );
}
