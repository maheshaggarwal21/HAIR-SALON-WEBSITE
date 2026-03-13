/**
 * @file AuthLayout.tsx
 * @description Full-screen layout for authentication pages.
 *
 * Renders a full-viewport background with the provided image,
 * a soft overlay to keep it subtle, and a centred slot for the form.
 */

interface AuthLayoutProps {
  children: React.ReactNode;
  /** Path to the background image (relative to /public) */
  backgroundImage?: string;
}

export default function AuthLayout({
  children,
  backgroundImage = "/experts-hair-3.webp",
}: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen w-full flex items-center justify-center overflow-hidden">

      {/* ── Full-page background image — slightly zoomed out so the logo is fully visible ── */}
      <div
        className="absolute inset-0 bg-no-repeat"
        style={{
          backgroundImage: `url(${backgroundImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center center",
          imageRendering: "auto",
          WebkitBackfaceVisibility: "hidden",
        }}
      />

      {/* ── Primary dark vignette — dims the image heavily ── */}
      {/* dimming effect to make the form more readable and to give a moody, intimate vibe that suits a hair salon. The radial gradient creates a subtle vignette effect, drawing attention towards the center where the form is located, while the flat dark layer ensures that the overall brightness is reduced without completely obscuring the background image. The warm tint adds a cohesive color tone that complements the amber accents in the UI, making the design feel more intentional and polished. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 90% at 50% 50%, rgba(8,6,4,0.60) 0%, rgba(6,4,2,0.82) 60%, rgba(4,2,0,0.94) 100%)",
        }}
      />

      {/* ── Flat dark base — ensures overall dimness is consistent ── */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(6, 4, 2, 0.52)" }}
      />

      {/* ── Subtle warm tint layer — ties amber accents to the photo ── */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(160deg, rgba(40,28,8,0.18) 0%, rgba(0,0,0,0) 55%, rgba(20,12,4,0.22) 100%)",
            // The warm tint layer adds a cohesive color tone that complements the amber accents in the UI, making the design feel more intentional and polished. By using a linear gradient with varying opacity, it creates a subtle warmth that enhances the overall mood of the page without overpowering the background image or making it too dark.
        }}
      />

      {/* ── Fine grain texture for analogue depth ── */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.78' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundSize: "200px",
        }}
      />

      {/* ── Form slot — shifted 15% right ── */}
      <div
        className="relative z-10 w-full flex items-center justify-center px-4 py-10 sm:py-14"
        style={{ paddingLeft: "1rem", paddingRight: "1rem" }}
      >
        {children}
      </div>
    </div>
  );
}
