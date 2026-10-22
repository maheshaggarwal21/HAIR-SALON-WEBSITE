/**
 * @file UpiQr.tsx
 * @description Draws a counter payment QR, large and clean (D60, part A).
 *
 * Two forms, chosen by the server:
 *   - "decoded": the server read the UPI payment string out of Razorpay's poster, and
 *     checked its amount. We redraw it ourselves as an SVG: sharp at any size, no
 *     Razorpay branding, high contrast, with a proper white quiet zone. Built as
 *     paths (not injected HTML).
 *   - "image": decoding failed, so show Razorpay's own poster, cropped to its QR.
 *
 * The QR is an exact square so a phone camera can read it from across the counter.
 */

import { useMemo } from "react";
import { encode } from "uqr";
import type { QrPayload } from "@/services/counter";

const QUIET = 3; // modules of white around the code

function QrSvg({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const m = encode(text, { ecc: "M", border: 0 });
    const parts: string[] = [];
    // One rectangle per horizontal run of dark modules keeps the path small.
    for (let y = 0; y < m.size; y++) {
      let x = 0;
      while (x < m.size) {
        if (!m.data[y][x]) { x++; continue; }
        const start = x;
        while (x < m.size && m.data[y][x]) x++;
        parts.push(`M${start + QUIET} ${y + QUIET}h${x - start}v1h-${x - start}z`);
      }
    }
    return { path: parts.join(""), size: m.size + QUIET * 2 };
  }, [text]);

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full" shapeRendering="crispEdges" role="img" aria-label="UPI payment QR code">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function CroppedPoster({ qr }: { qr: Extract<QrPayload, { mode: "image" }> }) {
  const { imgW, imgH, x, y, w } = qr.crop;
  // Scale the poster so the QR region fills the box; the rest is clipped away.
  const k = 100 / w;
  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <img
        src={qr.imageUrl}
        alt="UPI payment QR code"
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ width: `${imgW * k}%`, height: `${imgH * k}%`, left: `${-x * k}%`, top: `${-y * k}%` }}
      />
    </div>
  );
}

export default function UpiQr({ qr, className = "" }: { qr: QrPayload; className?: string }) {
  return (
    <div className={`aspect-square overflow-hidden rounded-2xl bg-white ${className}`}>
      {qr.mode === "decoded" ? <QrSvg text={qr.upi} /> : <CroppedPoster qr={qr} />}
    </div>
  );
}
