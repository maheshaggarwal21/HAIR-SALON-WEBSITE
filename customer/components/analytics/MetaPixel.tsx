"use client";

/**
 * Meta Pixel — base code, route-change PageView and the Contact event.
 *
 * Mounted once in the root layout, so every page loads the pixel exactly once
 * (a second copy would double the numbers). The id comes from
 * NEXT_PUBLIC_META_PIXEL_ID; with it unset (local dev, preview deployments) this
 * renders nothing, which keeps test traffic out of the ad account.
 *
 * The site is server-rendered but navigates client-side, so the base code's
 * PageView only covers the first load. `RouteViews` fires PageView on each later
 * path change.
 *
 * Contact: one delegated click listener marks every WhatsApp (wa.me) and call
 * (tel:) link, instead of editing each button. Links added later are covered
 * without anyone remembering to wire them.
 */

import { useEffect, useRef } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { track } from "@/lib/pixel";

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "";

function RouteViews() {
  const pathname = usePathname();
  const first = useRef(true);
  useEffect(() => {
    // The base code already sent PageView for the first load.
    if (first.current) {
      first.current = false;
      return;
    }
    track("PageView");
  }, [pathname]);
  return null;
}

function ContactClicks() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\/(wa\.me|api\.whatsapp\.com)\//i.test(href)) track("Contact", { content_name: "WhatsApp" });
      else if (/^tel:/i.test(href)) track("Contact", { content_name: "Call" });
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}

export function MetaPixel() {
  if (!PIXEL_ID) return null;
  return (
    <>
      <Script id="meta-pixel" strategy="afterInteractive">{`
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');
`}</Script>
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img height="1" width="1" style={{ display: "none" }} alt="" src={`https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`} />
      </noscript>
      <RouteViews />
      <ContactClicks />
    </>
  );
}
