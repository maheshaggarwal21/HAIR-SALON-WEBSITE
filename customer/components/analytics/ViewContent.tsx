"use client";

/**
 * Fires the pixel's ViewContent when a service, pricing or offer page shows.
 * Rendered by the server page; it draws nothing.
 */

import { useEffect } from "react";
import { track } from "@/lib/pixel";

export function ViewContent({ name }: { name: string }) {
  useEffect(() => {
    track("ViewContent", { content_name: name });
  }, [name]);
  return null;
}
