"use client";

import { usePathname } from "next/navigation";
import { useRef } from "react";
import { DemoModeAlert } from "@/components/demo-mode-alert";
import { useDemoMode } from "@/hooks/use-demo-mode";
import { SettingsPageHeader } from "./_components/settings-page-header";
import {
  getNavItem,
  SettingsMobileTabs,
  SettingsSidebar,
} from "./_components/settings-sidebar";
import { useSaveShortcut } from "./_components/use-save-shortcut";

// Pages that render their own header (e.g. with a toolbar on the right).
const PAGES_WITH_OWN_HEADER = new Set(["monitoring"]);
// Pages that need the full content width (charts).
const WIDE_PAGES = new Set(["monitoring"]);

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const demoMode = useDemoMode();
  const activeSection = pathname.split("/").pop() || "general";
  const navItem = getNavItem(activeSection);
  const contentRef = useRef<HTMLDivElement>(null);
  useSaveShortcut(contentRef);

  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <div className="md:hidden">
        <SettingsMobileTabs activeSection={activeSection} />
      </div>

      <aside className="hidden w-48 shrink-0 md:block">
        <div className="sticky top-4">
          <SettingsSidebar activeSection={activeSection} />
        </div>
      </aside>

      <div
        ref={contentRef}
        className={`min-w-0 flex-1 space-y-6 ${WIDE_PAGES.has(navItem.id) ? "" : "max-w-4xl"}`}
      >
        {!PAGES_WITH_OWN_HEADER.has(navItem.id) && (
          <SettingsPageHeader
            title={navItem.label}
            description={navItem.description}
          />
        )}
        {demoMode && <DemoModeAlert />}
        {children}
      </div>
    </div>
  );
}
