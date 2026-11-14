"use client";

import { motion } from "framer-motion";
import Link from "next/link";

interface NavItem {
  id: string;
  label: string;
  href: string;
}

const NAV_ITEMS: {
  id: string;
  label: string;
  path: string;
  title: string;
  description: string;
}[] = [
  {
    id: "general",
    label: "General",
    path: "",
    title: "General",
    description: "Name, hostname and lifecycle of this project.",
  },
  {
    id: "variables",
    label: "Env vars",
    path: "/variables",
    title: "Environment Variables",
    description:
      "Variables shared by every service in this project, including pull-request previews.",
  },
  {
    id: "environments",
    label: "Environments",
    path: "/environments",
    title: "Environments",
    description: "Rename or remove the environments in this project.",
  },
];

export function getProjectSettingsPage(activeSection: string): {
  title: string;
  description: string;
} {
  return (
    NAV_ITEMS.find((item) => isActiveItem(activeSection, item.id)) ??
    NAV_ITEMS[0]
  );
}

const LINK_FOCUS =
  "outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

function useNavItems(projectId: string): NavItem[] {
  const base = `/projects/${projectId}/settings`;

  return NAV_ITEMS.map((item) => ({
    id: item.id,
    label: item.label,
    href: `${base}${item.path}`,
  }));
}

function isActiveItem(activeSection: string, itemId: string): boolean {
  return (
    activeSection === itemId ||
    (activeSection === "settings" && itemId === "general")
  );
}

interface SettingsSidebarProps {
  projectId: string;
  activeSection: string;
}

export function SettingsSidebar({
  projectId,
  activeSection,
}: SettingsSidebarProps) {
  const navItems = useNavItems(projectId);

  return (
    <nav aria-label="Project settings" className="space-y-0.5">
      {navItems.map((item) => {
        const isActive = isActiveItem(activeSection, item.id);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`group relative block rounded-md px-3 py-2 text-sm transition-colors hover:bg-neutral-800/40 ${LINK_FOCUS}`}
          >
            {isActive && (
              <motion.div
                layoutId="project-settings-indicator"
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

export function SettingsMobileTabs({
  projectId,
  activeSection,
}: SettingsSidebarProps) {
  const navItems = useNavItems(projectId);

  return (
    <nav
      aria-label="Project settings"
      className="flex gap-1 overflow-x-auto pb-4"
    >
      {navItems.map((item) => {
        const isActive = isActiveItem(activeSection, item.id);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`group relative shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${LINK_FOCUS}`}
          >
            {isActive && (
              <motion.div
                layoutId="project-settings-mobile-indicator"
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
