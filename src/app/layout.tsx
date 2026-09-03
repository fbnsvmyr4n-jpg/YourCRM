import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "YourCRM — Grow. Manage. Close.",
  description: "A premium CRM for modern sales teams.",
  /* Installed to the home screen, iOS runs this without Safari's URL bar or the
     toolbar above the keyboard — roughly 110pt of a 700pt screen handed back,
     and no toolbar collapsing and expanding as you scroll.

     `default` for the status bar rather than `black-translucent`: translucent
     puts the page underneath the clock, and every screen here already opens
     with a header of its own. */
  appleWebApp: { capable: true, title: "YourCRM", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /* Run under the rounded corners and the home indicator, which is what makes
     an installed app look native rather than letterboxed. */
  viewportFit: "cover",
  /*
     The keyboard should SHRINK the page, not slide it.

     This is the standards-based answer to the trouble the chat page has had. By
     default a mobile browser leaves the layout viewport alone and PANS it to
     reveal the focused field, which is why the composer kept sliding out of
     view. `resizes-content` asks the browser to resize the layout instead, so
     the composer simply sits above the keyboard.

     Chrome honours it today; Safari does not yet, so the chat page still needs
     its own handling. Declaring it costs nothing and takes effect the day
     Safari ships it.
  */
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0f18" },
  ],
};

// Runs before paint to set the correct time-of-day palette and avoid a flash.
const noFlashScript = `(function(){try{
  var m = localStorage.getItem('yourcrm-theme-mode') || 'auto';
  var lvl = m;
  if(m === 'auto'){ var h = new Date().getHours();
    lvl = (h>=6 && h<18) ? 'light' : (h>=18 && h<21) ? 'dark' : 'midnight'; }
  // A phone has two palettes, so Evening collapses into Night. Mirrors
  // levelForViewport in lib/theme.ts — if that rule changes, change it here
  // too, or the first paint disagrees with every paint after it.
  if(lvl === 'dark' && window.matchMedia('(max-width: 639px)').matches){ lvl = 'midnight'; }
  document.documentElement.setAttribute('data-theme', lvl);
}catch(e){ document.documentElement.setAttribute('data-theme','light'); }})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      <head>
        {/*
            Written by hand because Next does not emit it.

            `appleWebApp.capable` produces `mobile-web-app-capable`, which is the
            modern standard — and iOS reads `apple-mobile-web-app-capable`.
            Verified against the rendered head: the Apple one was simply absent.

            Recent iOS will honour the manifest's `display: standalone` without
            it, but older versions read only this, and it is one line to have
            the app launch chrome-free on both.
        */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className="min-h-full antialiased">
        <div className="app-aurora" aria-hidden />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
