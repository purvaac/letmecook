"use client";

import { Geist, Playfair_Display } from "next/font/google";
import Link from "next/link";
import { usePathname } from "next/navigation";
import "./globals.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"] });

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${playfair.variable} antialiased`}>
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
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
