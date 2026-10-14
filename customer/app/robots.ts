/** robots.txt (T1.22). Everything closed until the production domain sets NEXT_PUBLIC_INDEXABLE=1. */

import type { MetadataRoute } from "next";
import { INDEXABLE, SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!INDEXABLE) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/_dev/"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
