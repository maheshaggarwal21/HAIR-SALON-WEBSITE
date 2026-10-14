/**
 * @file ToCustomerSite.tsx
 * @description Forwards an old public URL of the staff app (/about, /contact,
 * /privacy-policy, /terms-of-service) to the same page on the customer site
 * (T1.23), so old bookmarks and payment-gateway links keep working.
 */

import { useEffect } from "react";
import { CUSTOMER_SITE_URL } from "@/lib/customerSite";

export default function ToCustomerSite({ path }: { path: string }) {
  useEffect(() => {
    window.location.replace(`${CUSTOMER_SITE_URL}${path}`);
  }, [path]);
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "#faf8f4" }}>
      <div className="w-10 h-10 rounded-full border-4 border-stone-200 border-t-amber-500 animate-spin" />
    </div>
  );
}
