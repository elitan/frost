"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { BrandLockup } from "@/components/brand-lockup";
import {
  CommandPalette,
  CommandPaletteProvider,
  CommandPaletteTrigger,
} from "@/components/command-palette";
import { MainContentHeader } from "@/components/main-content-header";
import { MobileNav } from "@/components/mobile-nav";
import { ShellTopRow } from "@/components/shell-top-row";
import {
  ProjectSidebarSkeleton,
  ResourceGridSkeleton,
  SkeletonBlock,
} from "@/components/skeletons";
import { useDatabases } from "@/hooks/use-databases";
import {
  formatTitleSegments,
  useDocumentTitle,
} from "@/hooks/use-document-title";
import { useObjectStorages } from "@/hooks/use-object-storages";
import { orpc } from "@/lib/orpc-client";
import { cn } from "@/lib/utils";
import { CreateServiceModalProvider } from "./_components/create-service-modal-provider";
import { WorkspaceLeftMenu } from "./_components/workspace-left-menu";
import { CreateServiceModal } from "./projects/[id]/_components/create-service-modal";
import { ProjectLeftMenu } from "./projects/[id]/_components/project-left-menu";
import { CreateEnvironmentDialog } from "./projects/[id]/environments/_components/create-environment-dialog";

const SETTINGS_SECTION_LABELS: Record<string, string> = {
  monitoring: "Monitoring",
  domain: "Domain & SSL",
  registries: "Registries",
  "api-keys": "API Keys",
  github: "GitHub",
  cleanup: "Cleanup",
};

function getSettingsSectionLabel(section: string): string {
  return SETTINGS_SECTION_LABELS[section] ?? toTitleLabel(section);
}

function toTitleLabel(value: string): string {
  return value
    .split("-")
    .map(function toWord(word) {
      if (word.length === 0) {
        return word;
      }
      return `${word[0].toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();

  const rawProjectId = params.id;
  const projectId = typeof rawProjectId === "string" ? rawProjectId : "";
  const isProjectPage =
    pathname.startsWith("/projects/") && projectId.length > 0;
  const isResourceDetailPage =
    /^\/projects\/[^/]+\/environments\/[^/]+\/(services|databases|object-storages)\//.test(
      pathname,
    );
  const isSettingsPage =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    /^\/projects\/[^/]+\/settings(\/|$)/.test(pathname);
  const shouldCenterContent = isSettingsPage && !isResourceDetailPage;
  const showMainContentHeader = !isResourceDetailPage;

  const [createServiceModalOpen, setCreateServiceModalOpen] = useState(false);
  const [createEnvDialogOpen, setCreateEnvDialogOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const { data: environments = [], isLoading: isEnvironmentsLoading } =
    useQuery({
      ...orpc.environments.list.queryOptions({ input: { projectId } }),
      enabled: isProjectPage,
    });
  const { data: project } = useQuery({
    ...orpc.projects.get.queryOptions({ input: { projectId } }),
    enabled: isProjectPage,
    refetchInterval: 2000,
  });

  const currentEnvId = useMemo(
    function getCurrentEnvId() {
      if (!isProjectPage) {
        return "";
      }
      if (typeof params.envId === "string") {
        return params.envId;
      }
      const production = environments.find(
        (environment) => environment.type === "production",
      );
      return production?.id ?? environments[0]?.id ?? "";
    },
    [isProjectPage, params.envId, environments],
  );

  const selectedServiceId =
    typeof params.serviceId === "string" ? params.serviceId : null;
  const selectedDatabaseId = useMemo(
    function getSelectedDatabaseId() {
      if (typeof params.databaseId === "string") {
        return params.databaseId;
      }
      return null;
    },
    [params.databaseId],
  );
  const selectedObjectStorageId =
    typeof params.objectStorageId === "string" ? params.objectStorageId : null;

  const { data: currentEnvironment } = useQuery({
    ...orpc.environments.get.queryOptions({ input: { envId: currentEnvId } }),
    enabled: isProjectPage && currentEnvId.length > 0,
  });
  const { data: projectDatabases = [] } = useDatabases(
    selectedDatabaseId ? projectId : "",
  );
  const { data: projectObjectStorages = [] } = useObjectStorages(
    selectedObjectStorageId ? projectId : "",
  );

  const selectedResourceName = useMemo(
    function getSelectedResourceName(): string | null {
      if (selectedServiceId) {
        const service = currentEnvironment?.services.find(
          (candidate) => candidate.id === selectedServiceId,
        );
        return service?.name ?? null;
      }
      if (selectedDatabaseId) {
        const database = projectDatabases.find(
          (candidate) => candidate.id === selectedDatabaseId,
        );
        return database?.name ?? null;
      }
      if (selectedObjectStorageId) {
        const storage = projectObjectStorages.find(
          (candidate) => candidate.id === selectedObjectStorageId,
        );
        return storage?.name ?? null;
      }
      return null;
    },
    [
      selectedServiceId,
      selectedDatabaseId,
      selectedObjectStorageId,
      currentEnvironment?.services,
      projectDatabases,
      projectObjectStorages,
    ],
  );

  const documentTitle = useMemo(
    function getDocumentTitle(): string | null {
      if (pathname === "/") {
        return "Projects";
      }
      if (pathname === "/projects/new") {
        return "New project";
      }
      if (isProjectPage) {
        if (!project?.name) {
          return null;
        }
        if (isResourceDetailPage) {
          return selectedResourceName
            ? formatTitleSegments([project.name, selectedResourceName])
            : null;
        }
        const pathAfterProject = pathname.replace(/^\/projects\/[^/]+/, "");
        if (pathAfterProject.startsWith("/settings")) {
          return formatTitleSegments([project.name, "Settings"]);
        }
        return project.name;
      }
      if (pathname === "/settings") {
        return "Settings";
      }
      if (pathname.startsWith("/settings/")) {
        const section = pathname.replace(/^\/settings\//, "").split("/")[0];
        return formatTitleSegments([
          "Settings",
          getSettingsSectionLabel(section),
        ]);
      }
      return null;
    },
    [
      pathname,
      isProjectPage,
      isResourceDetailPage,
      project?.name,
      selectedResourceName,
    ],
  );

  // Layout-level default for every workspace route; pages may override.
  useDocumentTitle(documentTitle, { fallback: true });

  const mainHeaderTitle = useMemo(
    function getMainHeaderTitle() {
      if (pathname === "/") {
        return "Projects";
      }

      if (pathname === "/projects/new") {
        return "New Project";
      }

      if (isProjectPage) {
        const projectLabel = project?.name ?? (
          <SkeletonBlock className="h-4 w-28" />
        );
        const pathAfterProject = pathname.replace(/^\/projects\/[^/]+/, "");

        if (pathAfterProject.startsWith("/settings")) {
          return (
            <span className="flex items-center gap-2">
              <span className="truncate text-neutral-100">{projectLabel}</span>
              <span className="text-neutral-500">/</span>
              <span className="text-neutral-400">Settings</span>
            </span>
          );
        }

        if (pathAfterProject.startsWith("/environments")) {
          return (
            <span className="flex items-center gap-2">
              <span className="truncate text-neutral-100">{projectLabel}</span>
              <span className="text-neutral-500">/</span>
              <span className="text-neutral-400">Environments</span>
            </span>
          );
        }

        if (pathAfterProject.startsWith("/databases")) {
          return (
            <span className="flex items-center gap-2">
              <span className="truncate text-neutral-100">{projectLabel}</span>
              <span className="text-neutral-500">/</span>
              <span className="text-neutral-400">Databases</span>
            </span>
          );
        }

        return projectLabel;
      }

      if (pathname.startsWith("/settings/")) {
        const section = pathname.replace(/^\/settings\//, "").split("/")[0];
        return (
          <span className="flex items-center gap-2">
            <span className="text-neutral-100">Settings</span>
            <span className="text-neutral-500">/</span>
            <span className="text-neutral-400">
              {getSettingsSectionLabel(section)}
            </span>
          </span>
        );
      }

      if (pathname === "/settings") {
        return "Settings";
      }

      return "Workspace";
    },
    [pathname, isProjectPage, project?.name],
  );

  const bodyClassName = cn(
    "min-h-0 min-w-0 flex-1",
    isResourceDetailPage
      ? "overflow-hidden bg-neutral-950/20"
      : "overflow-auto p-4 md:p-6",
  );

  const openCreateEnvironmentDialog = useCallback(
    function openCreateEnvironmentDialog() {
      setMobileNavOpen(false);
      setCreateEnvDialogOpen(true);
    },
    [],
  );

  function handleCreateServiceModalOpenChange(open: boolean) {
    setCreateServiceModalOpen(open);
  }

  const createServiceModalContextValue = useMemo(
    function getCreateServiceModalContextValue() {
      return {
        openCreateServiceModal: function openCreateServiceModal() {
          setMobileNavOpen(false);
          setCreateServiceModalOpen(true);
        },
      };
    },
    [],
  );

  return (
    <CommandPaletteProvider>
      <CreateServiceModalProvider value={createServiceModalContextValue}>
        <main className="fixed inset-0 flex min-h-0">
          <MobileNav
            open={mobileNavOpen}
            onOpenChange={setMobileNavOpen}
            sidebar={
              isProjectPage ? (
                isEnvironmentsLoading ? (
                  <ProjectSidebarSkeleton header={<SidebarBrandRow />} />
                ) : (
                  <ProjectLeftMenu
                    projectId={projectId}
                    currentEnvId={currentEnvId}
                    selectedServiceId={selectedServiceId}
                    selectedDatabaseId={selectedDatabaseId}
                    selectedObjectStorageId={selectedObjectStorageId}
                    onOpenCreateService={function openCreateService() {
                      createServiceModalContextValue.openCreateServiceModal();
                    }}
                    onOpenCreateEnvironment={openCreateEnvironmentDialog}
                  />
                )
              ) : (
                <WorkspaceLeftMenu />
              )
            }
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950/20">
              {showMainContentHeader && (
                <MainContentHeader
                  title={mainHeaderTitle}
                  actions={
                    isProjectPage ? (
                      <CommandPaletteTrigger compact />
                    ) : undefined
                  }
                />
              )}
              <div className={bodyClassName}>
                {isProjectPage && isEnvironmentsLoading ? (
                  isResourceDetailPage ? null : (
                    <ResourceGridSkeleton />
                  )
                ) : shouldCenterContent ? (
                  <div className="mx-auto w-full max-w-[1200px]">
                    {children}
                  </div>
                ) : (
                  children
                )}
              </div>
            </div>
          </MobileNav>
        </main>

        {isProjectPage && currentEnvId && (
          <CreateServiceModal
            projectId={projectId}
            environmentId={currentEnvId}
            open={createServiceModalOpen}
            onOpenChange={handleCreateServiceModalOpenChange}
            onServiceCreated={function handleServiceCreated(serviceId) {
              router.push(
                `/projects/${projectId}/environments/${currentEnvId}/services/${serviceId}`,
              );
            }}
            onDatabaseCreated={function handleDatabaseCreated(databaseId) {
              router.push(
                `/projects/${projectId}/environments/${currentEnvId}/databases/${databaseId}`,
              );
            }}
            onObjectStorageCreated={function handleObjectStorageCreated(
              objectStorageId,
            ) {
              router.push(
                `/projects/${projectId}/environments/${currentEnvId}/object-storages/${objectStorageId}`,
              );
            }}
          />
        )}

        {isProjectPage && (
          <CreateEnvironmentDialog
            projectId={projectId}
            environments={environments}
            currentEnvId={currentEnvId}
            open={createEnvDialogOpen}
            onOpenChange={setCreateEnvDialogOpen}
          />
        )}

        <CommandPalette
          projectId={isProjectPage ? projectId : null}
          projectName={isProjectPage ? (project?.name ?? null) : null}
          environmentId={isProjectPage ? currentEnvId || null : null}
          onAddService={
            isProjectPage && currentEnvId
              ? createServiceModalContextValue.openCreateServiceModal
              : undefined
          }
          onCreateEnvironment={
            isProjectPage ? openCreateEnvironmentDialog : undefined
          }
        />
      </CreateServiceModalProvider>
    </CommandPaletteProvider>
  );
}

function SidebarBrandRow() {
  return (
    <ShellTopRow>
      <div className="flex w-full items-center justify-center">
        <BrandLockup />
      </div>
    </ShellTopRow>
  );
}
