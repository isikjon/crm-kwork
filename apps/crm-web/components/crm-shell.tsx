"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import { useState } from "react";
import type { AuthActor } from "../lib/auth-api";
import { logoutSession } from "../lib/auth-api";
import { NAV_ITEMS, type NavItem } from "../lib/site-data";
import { AuthActorProvider } from "./auth-actor-context";

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function actorHasAnyPermission(actor: AuthActor, required: string[] | undefined) {
  if (!required || required.length === 0) {
    return true;
  }

  if (actor.isTenantOwner || actor.isSupportUser) {
    return true;
  }

  return required.some((code) => actor.permissionCodes.includes(code));
}

function canAccessNavItem(actor: AuthActor, item: NavItem) {
  return actorHasAnyPermission(actor, item.requiredAnyPermissions);
}

interface CrmShellProps extends PropsWithChildren {
  actor: AuthActor;
}

function formatActorDisplayName(value: string) {
  const trimmed = value.trim();
  if (/^review owner$/i.test(trimmed)) {
    return "Владелец tenant";
  }

  return trimmed;
}

export function CrmShell({ actor, children }: CrmShellProps) {
  const pathname = usePathname();
  const [logoutPending, setLogoutPending] = useState(false);
  const normalizedPathname = pathname.startsWith("/rentals/") || pathname.startsWith("/buyouts/")
    ? "/orders"
    : pathname;
  const visibleNavItems = NAV_ITEMS.filter((item) => canAccessNavItem(actor, item));
  const currentItem = NAV_ITEMS.find((item) => isActivePath(normalizedPathname, item.href))
    ?? visibleNavItems[0]
    ?? NAV_ITEMS[0];
  const mobileItems = visibleNavItems.filter((item) => ["/orders", "/clients", "/bikes", "/finance", "/tariffs"].includes(item.href));

  async function handleLogout() {
    setLogoutPending(true);

    try {
      await logoutSession();
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <AuthActorProvider actor={actor}>
      <div className="crm-shell">
      <aside className="crm-sidebar">
        <div className="crm-brand">
          <div>
            <div className="crm-brand-title">{actor.tenantSlug.toUpperCase()} CRM</div>
            <div className="crm-brand-subtitle">{currentItem.label}</div>
          </div>
        </div>

        <nav className="crm-nav" aria-label="Основная навигация">
          {visibleNavItems.map((item) => {
            const active = isActivePath(normalizedPathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href as Route}
                className={["crm-nav-link", active ? "active" : ""].join(" ").trim()}
              >
                <span className="crm-nav-link-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="crm-main-wrap">
        <header className="crm-topbar">
          <div>
            <div className="crm-topbar-label">Рабочий экран</div>
            <h1 className="crm-topbar-title">{currentItem.label}</h1>
          </div>

          <div className="crm-topbar-actor">
            <div className="crm-topbar-actor-copy">
              <div className="crm-topbar-actor-name">{formatActorDisplayName(actor.fullName)}</div>
              <div className="crm-topbar-actor-meta">
                {actor.isTenantOwner ? "Владелец tenant" : (actor.roleNames[0] ?? actor.email)}
              </div>
            </div>

            <button
              type="button"
              className="crm-topbar-logout"
              onClick={handleLogout}
              disabled={logoutPending}
            >
              {logoutPending ? "Выход..." : "Выйти"}
            </button>
          </div>
        </header>

        <main className="crm-content">{children}</main>

        <nav className="crm-mobile-nav" aria-label="Нижняя навигация">
          {mobileItems.map((item) => {
            const active = isActivePath(normalizedPathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href as Route}
                className={["crm-mobile-link", active ? "active" : ""].join(" ").trim()}
              >
                {item.shortLabel}
              </Link>
            );
          })}
        </nav>
      </div>
      </div>
    </AuthActorProvider>
  );
}
