import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaperKalshi · Kalshi Paper Trading",
  description: "Paper-trade live Kalshi prediction markets with a fake $100,000 account.",
};

// Browser wallet extensions (MetaMask, etc.) inject scripts that throw on every page; in dev
// Next surfaces those in its error overlay even though they're not our code. Swallow errors
// whose origin is a browser extension, before anything else sees them. Real app errors are
// untouched.
const SUPPRESS_EXTENSION_ERRORS = `(function(){function ext(e){try{if(e&&typeof e.filename==='string'&&e.filename.indexOf('extension://')!==-1)return true;var s=e&&((e.reason&&e.reason.stack)||(e.error&&e.error.stack));if(typeof s==='string'&&s.indexOf('extension://')!==-1)return true;}catch(_){}return false;}window.addEventListener('error',function(e){if(ext(e)){e.stopImmediatePropagation();e.preventDefault();}},true);window.addEventListener('unhandledrejection',function(e){if(ext(e)){e.stopImmediatePropagation();e.preventDefault();}},true);})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: SUPPRESS_EXTENSION_ERRORS }} />
        {children}
      </body>
    </html>
  );
}
