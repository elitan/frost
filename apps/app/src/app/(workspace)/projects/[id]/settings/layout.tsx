"use client";

import { useParams, usePathname } from "next/navigation";
import { useRef } from "react";
import { SettingsPageHeader } from "@/app/(workspace)/settings/_components/settings-page-header";
import { useSaveShortcut } from "@/app/(workspace)/settings/_components/use-save-shortcut";
import {
  getProjectSettingsPage,
  SettingsMobileTabs,
  SettingsSidebar,
} from "./_components/settings-sidebar";

export default function ProjectSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const projectId = params.id as string;

  const pathname = usePathname();
  const parts = pathname.split("/");
  const activeSection = parts[parts.length - 1] || "general";
  const page = getProjectSettingsPage(activeSection);
  const contentRef = useRef<HTMLDivElement>(null);
  useSaveShortcut(contentRef);

  return (
    <div className="flex flex-col gap-8 md:flex-row">
      <div className="md:hidden">
        <SettingsMobileTabs
          projectId={projectId}
          activeSection={activeSection}
        />
      </div>

      <aside className="hidden w-48 shrink-0 md:block">
        <div className="sticky top-4">
          <SettingsSidebar
            projectId={projectId}
            activeSection={activeSection}
          />
        </div>
      </aside>

      <div ref={contentRef} className="min-w-0 max-w-4xl flex-1 space-y-6">
        <SettingsPageHeader title={page.title} description={page.description} />
        {children}
      </div>
    </div>
  );
}
