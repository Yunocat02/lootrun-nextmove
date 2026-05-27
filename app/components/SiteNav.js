"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/", label: "Lootrun" },
  { href: "/market", label: "Market" },
];

export default function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="site-nav" aria-label="Main navigation">
      <Link className="site-brand" href="/">
        YunYun
      </Link>
      <div className="site-links">
        {NAV_LINKS.map((link) => {
          const active =
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={active ? "site-link active" : "site-link"}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
