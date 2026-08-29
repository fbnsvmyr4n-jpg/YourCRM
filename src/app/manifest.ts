import type { MetadataRoute } from "next";

/**
 * What makes YourCRM installable.
 *
 * Asked directly: would the chat's keyboard trouble go away if this were an app
 * rather than a Safari tab? Partly — and the part that would is worth having on
 * its own, quite apart from that bug.
 *
 * `display: "standalone"` is the whole point. Installed from the share sheet,
 * the page runs without Safari's URL bar and without the toolbar above the
 * keyboard, which is roughly 110pt of a 700pt phone screen handed back to the
 * app. It also removes the toolbar that collapses and expands as you scroll —
 * the thing this project has spent several fixes working around, because a
 * viewport that changes height under you is the root of most of them.
 *
 * A CRM someone opens twenty times a day should be an icon on the home screen,
 * not a bookmark.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "YourCRM",
    short_name: "YourCRM",
    description: "A premium CRM for modern sales teams.",
    start_url: "/",
    display: "standalone",
    /* The app paints its own background before anything renders; matching the
       dark ground here stops a white flash on launch. */
    background_color: "#0b0f18",
    theme_color: "#0b0f18",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      /* Android crops icons to its own shape. The maskable copy keeps the mark
         inside the safe zone so the corners of the diamond are not shaved off. */
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
