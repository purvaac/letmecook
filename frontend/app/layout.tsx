"use client";

import { Plus_Jakarta_Sans } from "next/font/google";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getHealth, resetDemo } from "@/lib/api";
import { useCartStore } from "@/lib/store";
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

type ResetState = "idle" | "confirm" | "busy" | "done" | "error";

// Only shown when the backend says demo reset is on (the public demo). The
// first click asks for confirmation, the second one resets. The server then
// drops every socket, so all open screens reconnect and reload by themselves.
function ResetDemoButton() {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<ResetState>("idle");
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    getHealth().then((res) => setEnabled(res.ok && res.data.demoReset === true));
    return () => clearTimeout(timer.current);
  }, []);

  function backToIdleIn(ms: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ms);
  }

  async function onClick() {
    if (state === "idle" || state === "done" || state === "error") {
      setState("confirm");
      backToIdleIn(4000);
      return;
    }
    if (state !== "confirm") return;

    clearTimeout(timer.current);
    setState("busy");
    const res = await resetDemo();
    if (res.ok) {
      useCartStore.getState().clear();
      setState("done");
      backToIdleIn(2500);
    } else {
      setMessage(res.status === 429 ? "Just reset, try again soon" : "Reset failed");
      setState("error");
      backToIdleIn(3500);
    }
  }

  if (!enabled) return null;

  const look: Record<ResetState, string> = {
    idle: "border-line text-muted hover:border-muted hover:text-ink",
    confirm: "border-danger text-danger",
    busy: "border-line text-muted",
    done: "border-brand text-brand-dark",
    error: "border-danger text-danger",
  };
  const label: Record<ResetState, [string, string]> = {
    idle: ["Reset demo", ""],
    confirm: ["Reset stock & orders?", "Sure?"],
    busy: ["Resetting...", "..."],
    done: ["Reset done", "Done"],
    error: [message, "Error"],
  };
  const [long, short] = label[state];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "busy"}
      title="Restock the menu and delete all orders, for everyone"
      aria-label={long}
      className={`ml-auto flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-sm transition-colors sm:px-3 ${look[state]}`}
    >
      <svg
        viewBox="0 0 24 24"
        className={`size-4 ${state === "busy" ? "animate-spin" : ""}`}
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
      <span className="hidden sm:inline">{long}</span>
      {short && <span className="sm:hidden">{short}</span>}
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
