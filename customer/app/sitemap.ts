/** sitemap.xml (T1.22): every public page, from the same cached menu and team the pages use. */

import type { MetadataRoute } from "next";
import { getArtists, getServices } from "@/lib/api";
import { SITE_URL } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [her, him, artists] = await Promise.all([getServices("her"), getServices("him"), getArtists()]);
  const services = [...new Set([...(her ?? []), ...(him ?? [])].map((c) => c.slug))];
  const page = (path: string, priority: number): MetadataRoute.Sitemap[number] => ({ url: `${SITE_URL}${path}`, priority });
  return [
    page("/", 1),
    page("/services", 0.9),
    page("/artists", 0.7),
    page("/book", 0.6),
    page("/offers/karva-chauth", 0.6),
    ...services.map((s) => page(`/services/${s}`, 0.8)),
    ...(artists ?? []).filter((a) => a.slug).map((a) => page(`/artists/${a.slug}`, 0.5)),
    page("/privacy", 0.2),
    page("/terms", 0.2),
    page("/cancellation-policy", 0.2),
  ];
}
