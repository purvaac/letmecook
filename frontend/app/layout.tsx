"use client";

import { Plus_Jakarta_Sans } from "next/font/google";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getHealth, resetDemo } from "@/lib/api";
import { onMessage } from "@/lib/socket";
import { useCartStore, useDemoStore } from "@/lib/store";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin"] });

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const active = usePathname() === href;
  return (
    <Link
      href={href}
      className={`flex min-h-10 items-center rounded-md px-2 text-sm sm:px-3 ${
        active ? "font-semibold text-brand-dark" : "text-muted hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

// Matches the backend's cooldown between two resets.
const RESET_COOLDOWN_S = 5;

// Only shown when the backend says demo reset is on (the public demo). One
// click resets; the server then drops every socket and all open screens
// reconnect and reload by themselves. Between resets the button is disabled
// and counts down, so it never looks like a click was ignored.
function ResetDemoButton() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [doneUntil, setDoneUntil] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    getHealth().then((res) => setEnabled(res.ok && res.data.demoReset === true));
  }, []);

  // The header is never hidden, so this listener hears every reset, whichever
  // page is showing (see useDemoStore).
  useEffect(() => onMessage("demo:reset", () => useDemoStore.getState().bumpResets()), []);

  // Tick only while there is a countdown or a "done" message to clear.
  const ticking = waitUntil > now || doneUntil > now || failed;
  useEffect(() => {
    if (!ticking) return;
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setFailed((f) => f && t < waitUntil);
    }, 250);
    return () => clearInterval(tick);
  }, [ticking, waitUntil]);

  async function onClick() {
    // A ref, not state: a second click before React re-renders must not
    // send a second request.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);

    const res = await resetDemo();
    const t = Date.now();
    if (res.ok) {
      useCartStore.getState().clear();
      setDoneUntil(t + 1500);
      setWaitUntil(t + RESET_COOLDOWN_S * 1000);
    } else if (res.status === 429) {
      setWaitUntil(t + (res.error.retryAfterSeconds ?? RESET_COOLDOWN_S) * 1000);
    } else {
      setFailed(true);
      setWaitUntil(t + 3000);
    }
    setNow(t);
    setBusy(false);
    inFlight.current = false;
  }

  if (!enabled) return null;

  const secondsLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  let label = "Reset demo";
  let tone = "border-line text-muted hover:border-muted hover:text-ink";
  if (busy) {
    label = "Resetting...";
  } else if (failed) {
    label = "Reset failed";
    tone = "border-danger text-danger";
  } else if (doneUntil > now) {
    label = "Reset done";
    tone = "border-brand text-brand-dark";
  } else if (secondsLeft > 0) {
    label = `Wait ${secondsLeft}s`;
  }
  const disabled = busy || (!failed && secondsLeft > 0);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Restock the menu and delete all orders, for everyone"
      aria-label={label}
      className={`ml-auto flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border bg-card px-2.5 text-sm transition-colors disabled:cursor-not-allowed sm:w-36 sm:px-3 ${tone}`}
    >
      <svg
        viewBox="0 0 24 24"
        className={`size-4 shrink-0 ${busy ? "animate-spin" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
      </svg>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} antialiased`}>
      <body className="min-h-screen bg-paper font-sans text-ink">
        <title>letmecook</title>
        <header className="border-b border-line bg-paper">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4 sm:gap-4 sm:px-6">
            {/* Logo */}
            <Link
              href="/"
              aria-label="letmecook home"
              className="h-7 w-[158px] shrink-0 bg-[url(/letmecook.png)] bg-[length:190px_190px] bg-[position:-17px_-79px] bg-no-repeat"
            />
            <nav className="flex min-w-0 items-center">
              <NavLink href="/">Menu</NavLink>
              <NavLink href="/kitchen">Kitchen</NavLink>
            </nav>
            <ResetDemoButton />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
