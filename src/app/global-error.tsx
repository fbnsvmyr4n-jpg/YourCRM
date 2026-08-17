"use client";

/**
 * Last resort: a failure in the root layout itself.
 *
 * This one replaces the entire document, so it cannot rely on the app shell,
 * the theme provider, or any token from `globals.css` — none of them are
 * guaranteed to have rendered. Everything here is inline and self-contained,
 * and the palette is fixed rather than themed for the same reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f18",
          color: "#e7ecf3",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          padding: "24px",
        }}
      >
        <div style={{ maxWidth: "26rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "20px", fontWeight: 600, margin: "0 0 8px" }}>
            YourCRM could not start
          </h1>
          <p style={{ fontSize: "14px", lineHeight: 1.6, color: "#8494a9", margin: "0 0 20px" }}>
            Something failed before the app could load. Your data has not been touched.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "inherit",
              fontSize: "14px",
              fontWeight: 600,
              color: "#08131a",
              background: "#62b6d2",
              border: 0,
              borderRadius: "12px",
              padding: "10px 20px",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ marginTop: "20px", fontSize: "11px", color: "#5c6b80" }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
