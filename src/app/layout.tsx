import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "YourCRM — Grow. Manage. Close.",
  description: "A premium CRM for modern sales teams.",
};

// Runs before paint to set the correct time-of-day palette and avoid a flash.
const noFlashScript = `(function(){try{
  var m = localStorage.getItem('yourcrm-theme-mode') || 'auto';
  var lvl = m;
  if(m === 'auto'){ var h = new Date().getHours();
    lvl = (h>=6 && h<18) ? 'light' : (h>=18 && h<21) ? 'dark' : 'midnight'; }
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
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body className="min-h-full antialiased">
        <div className="app-aurora" aria-hidden />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
