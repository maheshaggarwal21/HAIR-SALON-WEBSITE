"use client";

/**
 * `rise` (DS §4) for content below the fold. One shared IntersectionObserver
 * marks `.reveal` elements `.is-in` as they come into view. Without the
 * `.motion-ok` class on <html> (no JS, reduced motion) the CSS never hides
 * anything, so nothing depends on this running.
 */

import { useEffect } from "react";

export function RevealObserver() {
  useEffect(() => {
    if (!document.documentElement.classList.contains("motion-ok") || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    const watch = () => document.querySelectorAll(".reveal:not(.is-in)").forEach((el) => io.observe(el));
    watch();
    // Pages swap content on client navigation; pick up new sections.
    const mo = new MutationObserver(watch);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
  return null;
}
