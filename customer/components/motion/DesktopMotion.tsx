/**
 * Desktop-only motion gate (DS §4). Components that load GSAP on demand (the
 * hero video's card-expand) check this query first, so phones and anyone who
 * asked for reduced motion never download it.
 *
 * Lenis smooth scroll used to live here and was removed (CF D26, 14 Oct 2026).
 * It took over the mouse wheel, so the request sheet's own list could not be
 * scrolled, and it measured the page height once, so the /services page stopped
 * scrolling partway after the list grew. Native scrolling is already smooth on
 * trackpads and costs no JavaScript.
 */

export const desktopMotionQuery = "(pointer: fine) and (min-width: 1024px) and (prefers-reduced-motion: no-preference)";
