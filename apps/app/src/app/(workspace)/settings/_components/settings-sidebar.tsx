"use client";

import { motion } from "framer-motion";
import Link from "next/link";

interface NavItem {
  id: string;
  label: string;
  href: string;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: "general",
    label: "General",
    href: "/settings",
    description:
      "Version, updates, backups and access for this Frost instance.",
  },
  {
    id: "monitoring",
    label: "Monitoring",
    href: "/settings/monitoring",
    description: "Real-time CPU, memory and disk usage for this server.",
  },
  {
    id: "domain",
    label: "Domain & SSL",
    href: "/settings/domain",
    description:
      "Serve Frost over HTTPS and give services automatic subdomains.",
  },
  {
    id: "registries",
    label: "Registries",
    href: "/settings/registries",
    description: "Credentials for pulling images from private registries.",
  },
  {
    id: "api-keys",
    label: "API Keys",
    href: "/settings/api-keys",
    description: "Keys for scripts and CI to call the Frost API.",
  },
  {
    id: "github",
    label: "GitHub",
    href: "/settings/github",
    description:
      "Connect a GitHub App to deploy straight from your repositories.",
  },
  {
    id: "cleanup",
    label: "Cleanup",
    href: "/settings/cleanup",
    description:
      "Reclaim disk space from old Docker images, containers and networks.",
  },
];

export function getNavItem(activeSection: string): NavItem {
  return NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0];
}

const LINK_FOCUS =
  "outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

interface SettingsSidebarProps {
  activeSection: string;
}

export function SettingsSidebar({ activeSection }: SettingsSidebarProps) {
  return (
    <nav aria-label="Settings" className="space-y-0.5">
      {NAV_ITEMS.map((item) => {
        const isActive =
          activeSection === item.id ||
          (activeSection === "settings" && item.id === "general");
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`group relative block rounded-md px-3 py-2 text-sm transition-colors hover:bg-neutral-800/40 ${LINK_FOCUS}`}
          >
            {isActive && (
              <motion.div
                layoutId="global-settings-indicator"
                className="absolute inset-0 rounded-md bg-neutral-800"
                transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
              />
            )}
            <span
              className={`relative z-10 ${isActive ? "font-medium text-white" : "text-neutral-400 group-hover:text-neutral-200"}`}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

export function SettingsMobileTabs({ activeSection }: SettingsSidebarProps) {
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto pb-4">
      {NAV_ITEMS.map((item) => {
        const isActive =
          activeSection === item.id ||
          (activeSection === "settings" && item.id === "general");
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`group relative shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${LINK_FOCUS}`}
          >
            {isActive && (
              <motion.div
                layoutId="global-settings-mobile-indicator"
                className="absolute inset-0 rounded-md bg-neutral-800"
                transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
              />
            )}
            <span
              className={`relative z-10 ${isActive ? "text-white" : "text-neutral-400 group-hover:text-neutral-200"}`}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
