"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Box,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  FileText,
  GitFork,
  Globe,
  Home,
  LibraryBig,
  LogOut,
  Menu,
  MessageSquare,
  ScrollText,
  Plug,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
  Users,
  X,
} from "lucide-react";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { DEFAULT_AUTH_NAME } from "../../_lib/den-flow";
import {
  formatRoleLabel,
  getAnalyticsRoute,
  getAutomationsRoute,
  getBackgroundAgentsRoute,
  getApiKeysRoute,
  getBrandAppearanceRoute,
  getBillingRoute,
  getCustomLlmProvidersRoute,
  getDiagnosticsRoute,
  getDesktopPoliciesRoute,
  getOrgAccessFlags,
  getIntegrationsRoute,
  getInferenceRoute,
  getLibraryRoute,
  getMcpConnectionsRoute,
  getManagedBrandIconUrl,
  getMembersRoute,
  getToolTesterRoute,
  getYourConnectionsRoute,
  getOrgDashboardRoute,
  getOrgSettingsRoute,
  getMarketplacesRoute,
  getPluginsRoute,
  getSsoRoute,
  getScimRoute,
  getWorkflowRunsRoute,
  getWebRoute,
} from "../../_lib/den-org";
import { useOrgListWindow } from "../../_lib/use-org-list-window";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { buildDenFeedbackUrl } from "../../_lib/feedback";
import { OrgSelectionScreen } from "./org-selection-screen";
import { UserProfileDialog } from "./user-profile-dialog";

const SOFIA_DOCS_URL = "/docs";

type DashboardNavChild = {
  href: string;
  label: string;
  badge?: string;
};

type DashboardNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  testId?: string;
  /**
   * Grouped entries (Models, Settings) link to the first child and expand
   * their children while the current page is inside the group.
   */
  children?: DashboardNavChild[];
};

type DashboardNavSection = {
  label: string;
  items: DashboardNavItem[];
};

function OrgMark({ name }: { name: string }) {
  const initials = useMemo(() => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return (parts[0]?.slice(0, 1) ?? "O") + (parts[1]?.slice(0, 1) ?? "");
  }, [name]);

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#011627] text-xs font-semibold uppercase tracking-[0.08em] text-white">
      {initials}
    </div>
  );
}

function SofiaMark({ className = "h-9 w-auto" }: { className?: string }) {
  return <img src="/sofia-mark.svg" alt="Sofia" className={className} />;
}

export function SidebarBrandMark({
  metadata,
  organizationName,
}: {
  metadata: string | null | undefined;
  organizationName: string;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (metadata === undefined) {
    return (
      <div
        className="h-10 w-10 rounded-xl"
        aria-label="Loading organization icon"
        data-sidebar-brand-icon="loading"
      />
    );
  }

  const iconUrl = getManagedBrandIconUrl(metadata);
  if (!iconUrl || failedUrl === iconUrl) {
    return (
      <div data-sidebar-brand-icon="fallback">
        <SofiaMark />
      </div>
    );
  }

  return (
    <div
      className="h-10 w-10 overflow-hidden rounded-xl"
      data-sidebar-brand-icon={loadedUrl === iconUrl ? "ready" : "loading"}
    >
      <img
        src={iconUrl}
        alt={`${organizationName} icon`}
        className={`h-full w-full object-contain transition-opacity ${loadedUrl === iconUrl ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setLoadedUrl(iconUrl)}
        onError={() => setFailedUrl(iconUrl)}
      />
    </div>
  );
}

const DEFAULT_WORKSPACE_FAVICON_HREF = "/sofia-mark.svg";

export function WorkspaceFavicon({
  metadata,
}: {
  metadata: string | null | undefined;
}) {
  const orgContextLoading = metadata === undefined;
  const iconUrl = getManagedBrandIconUrl(metadata ?? null);

  useEffect(() => {
    if (orgContextLoading) {
      // Keep the server-rendered favicon until the org context is known.
      return;
    }

    let favicon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }

    if (!iconUrl) {
      favicon.href = DEFAULT_WORKSPACE_FAVICON_HREF;
      favicon.removeAttribute("type");
      return;
    }

    const previousHref = favicon.getAttribute("href");
    const previousType = favicon.getAttribute("type");
    favicon.href = iconUrl;
    favicon.type = iconUrl.toLowerCase().endsWith(".jpg")
      || iconUrl.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";

    return () => {
      if (previousHref === null) {
        favicon.setAttribute("href", DEFAULT_WORKSPACE_FAVICON_HREF);
      } else {
        favicon.setAttribute("href", previousHref);
      }
      if (previousType === null) {
        favicon.removeAttribute("type");
      } else {
        favicon.setAttribute("type", previousType);
      }
    };
  }, [orgContextLoading, iconUrl]);

  return null;
}

function getDashboardPageTitle(pathname: string, orgSlug: string | null) {
  if (!orgSlug) {
    return "Home";
  }

  const dashboardRoot = getOrgDashboardRoute(orgSlug);

  if (pathname === dashboardRoot) {
    return "Home";
  }
  if (pathname.startsWith(getAnalyticsRoute(orgSlug))) {
    return "Analytics";
  }
  if (pathname.startsWith(getMembersRoute(orgSlug))) {
    return "Members";
  }
  if (pathname.startsWith(getApiKeysRoute(orgSlug))) {
    return "API Keys";
  }
  if (pathname.startsWith(getScimRoute(orgSlug))) {
    return "SCIM";
  }
  if (pathname.startsWith(getSsoRoute(orgSlug))) {
    return "SSO";
  }
  if (pathname.startsWith(getBackgroundAgentsRoute(orgSlug))) {
    return "Background Tasks";
  }
  if (pathname.startsWith(getAutomationsRoute(orgSlug))) {
    return "My Automations";
  }
  if (pathname.startsWith(getCustomLlmProvidersRoute(orgSlug))) {
    return "Bring your Own Keys";
  }
  if (pathname.startsWith(getDesktopPoliciesRoute(orgSlug))) {
    return "Desktop Policies";
  }
  if (pathname.startsWith(getDiagnosticsRoute(orgSlug))) {
    return "Diagnostics";
  }
  if (pathname.startsWith(getInferenceRoute(orgSlug))) {
    return "Sofia Models";
  }
  if (pathname.startsWith(getWebRoute(orgSlug))) {
    return "Sofia Web";
  }
  if (pathname.startsWith(getLibraryRoute(orgSlug))) {
    return "My Library";
  }
  if (pathname.startsWith(getPluginsRoute(orgSlug))) {
    return "Plugin Directory";
  }
  if (pathname.startsWith(getMarketplacesRoute(orgSlug))) {
    return "Collections";
  }
  if (pathname.startsWith(getIntegrationsRoute(orgSlug))) {
    return "Sources";
  }
  if (pathname.startsWith(getMcpConnectionsRoute(orgSlug))) {
    return "Connectors";
  }
  if (pathname.startsWith(getYourConnectionsRoute(orgSlug))) {
    return "Your Connections";
  }
  if (pathname.startsWith(getWorkflowRunsRoute(orgSlug))) {
    return "Workflow Runs";
  }
  if (pathname.startsWith(getToolTesterRoute(orgSlug))) {
    return "Tool Tester";
  }
  if (pathname.startsWith(getBillingRoute(orgSlug))) {
    return "Billing";
  }
  if (pathname.startsWith(getBrandAppearanceRoute(orgSlug))) {
    return "Brand appearance";
  }
  if (pathname.startsWith(getOrgSettingsRoute(orgSlug))) {
    return "Org Settings";
  }

  return "Home";
}

export function OrgDashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut, updateUserProfile, runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const {
    activeOrg,
    orgDirectory,
    orgContext,
    orgSelectionRequired,
    orgBusy,
    orgError,
    mutationBusy,
    switchOrganization,
  } = useOrgDashboard();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profilePromptDismissed, setProfilePromptDismissed] = useState(false);
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const isSingleOrgMode = runtimeConfigLoaded && runtimeConfig.orgMode === "single_org";
  const {
    query: switcherQuery,
    setQuery: setSwitcherQuery,
    visible: visibleOrgDirectory,
    filteredCount: switcherFilteredCount,
    hiddenCount: switcherHiddenCount,
    hasMore: switcherHasMore,
    showMore: showMoreOrgDirectory,
    showSearch: showSwitcherSearch,
  } = useOrgListWindow(orgDirectory, 20);

  useEffect(() => {
    if (!switcherOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const clickedInsideSwitcher = event.composedPath().some(
        (target) => target instanceof Element && target.hasAttribute("data-workspace-switcher-root"),
      );
      if (!clickedInsideSwitcher) {
        setSwitcherOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSwitcherOpen(false);
      switcherTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [switcherOpen]);

  if (orgSelectionRequired) {
    return (
      <OrgSelectionScreen
        orgs={orgDirectory}
        onSelect={switchOrganization}
        onSignOut={() => void signOut()}
        busy={mutationBusy === "switch-organization"}
        error={orgError}
      />
    );
  }

  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );

  const pageTitle = getDashboardPageTitle(pathname, activeOrg?.slug ?? null);
  const shouldShowProfilePrompt = Boolean(
    user &&
      !profilePromptDismissed &&
      user.name?.trim() === DEFAULT_AUTH_NAME,
  );
  const showFeedbackLink = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";
  const feedbackHref = buildDenFeedbackUrl({
    pathname,
    orgSlug: activeOrg?.slug,
  });
  const mcpConnectionsEnabled = orgContext?.capabilities.mcpConnections === true;
  const workflowsEnabled = orgContext?.capabilities.workflows === true;
  // Web access is backed by the existing hosted cloud capability. The org
  // payload only reports `cloud` after the server rollout helper has verified
  // the multi-org deployment gate, so the sidebar stays hidden by default until
  // both config and org context load.
  const showWeb = runtimeConfigLoaded && orgContext?.capabilities.cloud === true;

  // One nav, two audiences. Members see Work only. Admins add Manage
  // (catalog + connectors + models), Observability, and Team. Connections
  // live inside My Library; Tool Tester lives under Settings.
  const workItems: DashboardNavItem[] = [
    {
      href: activeOrg ? getOrgDashboardRoute(activeOrg.slug) : "#",
      label: "Dashboard",
      icon: Home,
    },
    {
      href: activeOrg ? getLibraryRoute(activeOrg.slug) : "#",
      label: "My Library",
      icon: LibraryBig,
    },
    ...(workflowsEnabled && activeOrg
      ? [{
          href: getAutomationsRoute(activeOrg.slug),
          label: "My Automations",
          icon: CalendarClock,
        }]
      : []),
    ...(showWeb
      ? [{
          href: activeOrg ? getWebRoute(activeOrg.slug) : "#",
          label: "Sofia Web",
          icon: Globe,
          badge: "Alpha",
        }]
      : []),
  ];
  // Sofia Models are a hosted Sofia Cloud offering; self-hosted
  // (single-org) deployments only manage their own LLM providers. Default
  // hidden until the runtime config confirms a hosted (multi-org) deployment.
  const showSofiaModels = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";
  const modelsGroup: DashboardNavItem | null = access.isAdmin && activeOrg
    ? {
        href: showSofiaModels
          ? getInferenceRoute(activeOrg.slug)
          : getCustomLlmProvidersRoute(activeOrg.slug),
        label: "Models",
        icon: Sparkles,
        badge: "Providers",
        children: [
          ...(showSofiaModels
            ? [{ href: getInferenceRoute(activeOrg.slug), label: "Sofia Models" }]
            : []),
          { href: getCustomLlmProvidersRoute(activeOrg.slug), label: "Bring your Own Keys" },
        ],
      }
    : null;
  const manageItems: DashboardNavItem[] = access.isAdmin && activeOrg
    ? [
        {
          href: getMarketplacesRoute(activeOrg.slug),
          label: "Collections",
          icon: Puzzle,
        },
        {
          href: getPluginsRoute(activeOrg.slug),
          label: "Plugin Directory",
          icon: Box,
        },
        {
          href: getMcpConnectionsRoute(activeOrg.slug),
          label: "Connectors",
          icon: Plug,
          badge: "MCPs",
        },
        {
          href: getIntegrationsRoute(activeOrg.slug),
          label: "Sources",
          icon: GitFork,
          badge: "Alpha",
        },
        ...(modelsGroup ? [modelsGroup] : []),
      ]
    : [];
  const observabilityItems: DashboardNavItem[] = access.isAdmin && activeOrg
    ? [
        ...(workflowsEnabled
          ? [{
              href: getWorkflowRunsRoute(activeOrg.slug),
              label: "Workflow Runs",
              icon: ScrollText,
              testId: "nav-workflow-runs",
            }]
          : []),
        { href: getAnalyticsRoute(activeOrg.slug), label: "Analytics", icon: BarChart3 },
      ]
    : [];
  const settingsChildren: DashboardNavChild[] = activeOrg
    ? [
        ...(access.canViewSettings
          ? [
              { href: getOrgSettingsRoute(activeOrg.slug), label: "General" },
              { href: getDiagnosticsRoute(activeOrg.slug), label: "Diagnostics" },
              { href: getBrandAppearanceRoute(activeOrg.slug), label: "Brand appearance" },
              { href: getDesktopPoliciesRoute(activeOrg.slug), label: "Desktop Policies" },
              { href: getBillingRoute(activeOrg.slug), label: "Billing" },
              { href: getApiKeysRoute(activeOrg.slug), label: "API Keys" },
              { href: getSsoRoute(activeOrg.slug), label: "SSO" },
              { href: getScimRoute(activeOrg.slug), label: "SCIM" },
            ]
          : []),
        ...(mcpConnectionsEnabled && access.isAdmin
          ? [{ href: getToolTesterRoute(activeOrg.slug), label: "Tool Tester" }]
          : []),
      ]
    : [];
  const settingsGroup: DashboardNavItem | null = settingsChildren.length > 0
    ? {
        href: settingsChildren[0].href,
        label: "Settings",
        icon: SlidersHorizontal,
        children: settingsChildren,
      }
    : null;
  const teamItems: DashboardNavItem[] = [
    ...(access.isAdmin && activeOrg
      ? [{ href: getMembersRoute(activeOrg.slug), label: "Members", icon: Users }]
      : []),
    ...(settingsGroup ? [settingsGroup] : []),
  ];
  const navSections: DashboardNavSection[] = [
    { label: "Work", items: workItems },
    ...(manageItems.length > 0 ? [{ label: "Manage", items: manageItems }] : []),
    ...(observabilityItems.length > 0 ? [{ label: "Observability", items: observabilityItems }] : []),
    ...(teamItems.length > 0 ? [{ label: "Team", items: teamItems }] : []),
  ];

  const orgSwitcher = isSingleOrgMode ? (
    <div className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <OrgMark name={activeOrg?.name ?? runtimeConfig.singleOrgName} />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-gray-900">
            {activeOrg?.name ?? runtimeConfig.singleOrgName}
          </p>
          <p className="truncate text-[12px] text-gray-500">
            {activeOrg ? formatRoleLabel(activeOrg.role) : "Preparing workspace"}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        className="shrink-0 rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-900"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  ) : (
    <div data-workspace-switcher-root="" className="relative">
      <button
        ref={switcherTriggerRef}
        type="button"
        data-testid="workspace-switcher-trigger"
        className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-100"
        onClick={() => setSwitcherOpen((current) => !current)}
        aria-expanded={switcherOpen}
        aria-haspopup="dialog"
      >
        <div className="flex min-w-0 items-center gap-3">
          <OrgMark name={activeOrg?.name ?? "Sofia"} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-medium text-gray-900">
              {activeOrg?.name ?? "Loading..."}
            </p>
            <p className="truncate text-[12px] text-gray-500">
              {activeOrg ? formatRoleLabel(activeOrg.role) : "Preparing workspace"}
            </p>
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0">
          <path d="M17 3l4 4-4 4"/>
          <path d="M3 7h18"/>
          <path d="M7 21l-4-4 4-4"/>
          <path d="M21 17H3"/>
        </svg>
      </button>

      {switcherOpen ? (
        <div
          data-testid="workspace-switcher-menu"
          role="dialog"
          aria-label="Workspace switcher"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 grid w-[240px] max-w-[calc(100vw-1.5rem)] grid-cols-[minmax(0,1fr)] gap-1 rounded-2xl border border-gray-200 bg-white py-2 shadow-[0_12px_24px_-12px_rgba(0,0,0,0.15)]"
        >
          <div className="min-w-0 px-3 py-1.5">
            <p className="truncate text-[13px] font-medium text-gray-900">
              {user?.email ?? "Sofia user"}
            </p>
          </div>
          
          <div className="mx-2 h-px bg-gray-100 my-1" />

          <div className="px-3 pb-1 pt-1">
            <p className="text-[11px] font-medium text-gray-500">
              Switch workspace
            </p>
          </div>

          {showSwitcherSearch ? (
            <div className="px-2 pb-1">
              <input
                type="search"
                value={switcherQuery}
                onChange={(event) => setSwitcherQuery(event.target.value)}
                placeholder="Search workspaces"
                className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-900 outline-none transition focus:border-gray-400"
              />
            </div>
          ) : null}

          <div className="grid max-h-64 gap-0.5 overflow-y-auto px-1.5">
            {visibleOrgDirectory.map((org) => (
              <button
                key={org.id}
                type="button"
                onClick={() => {
                  setSwitcherOpen(false);
                  switchOrganization(org.slug);
                }}
                className={`flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  org.isActive
                    ? "bg-gray-50 text-gray-900"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="min-w-0">
                    <span className="block truncate text-[13px] font-medium tracking-[-0.1px]">{org.name}</span>
                    <span className="block truncate text-[12px] text-gray-500">
                      {org.role === "owner" ? "Creator plan" : "Free plan"} • {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                    </span>
                  </div>
                </div>
                {org.isActive ? (
                  <svg className="h-4 w-4 shrink-0 text-gray-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : null}
              </button>
            ))}
          </div>

          {switcherFilteredCount === 0 && switcherQuery ? (
            <p className="px-3 py-1 text-[12px] text-gray-500">No organizations match your search.</p>
          ) : null}

          {switcherHasMore ? (
            <div className="px-1.5">
              <button
                type="button"
                onClick={showMoreOrgDirectory}
                className="flex w-full items-center justify-center rounded-lg px-2 py-1.5 text-[12px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
              >
                Show more ({switcherHiddenCount})
              </button>
            </div>
          ) : null}

          <div className="px-1.5 mt-0.5">
            <Link
              href="/organization"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
              onClick={() => setSwitcherOpen(false)}
            >
              <span className="text-gray-400 text-[16px] leading-none">+</span> Create or join workspace
            </Link>
          </div>

          <div className="mx-2 h-px bg-gray-100 my-1" />

          <div className="px-1.5">
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900"
            >
              <LogOut className="h-4 w-4 text-gray-400" />
              Sign out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  const sidebarContent = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-gray-100 px-4 pb-4 pt-5">
        <div className="flex items-center justify-between gap-3">
          <SidebarBrandMark
            metadata={orgContext?.organization.metadata}
            organizationName={activeOrg?.name ?? runtimeConfig.singleOrgName}
          />
          <button
            type="button"
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <nav className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-5" data-testid="den-org-sidebar">
        <div className="space-y-5">
          {navSections.map((section) => (
            <div key={section.label} data-sidebar-section={section.label.toLowerCase()}>
              <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400">
                {section.label}
              </p>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const isDashboardRoot =
                    activeOrg && item.href === getOrgDashboardRoute(activeOrg.slug);
                  const isLibraryItem =
                    Boolean(activeOrg && item.href === getLibraryRoute(activeOrg.slug));
                  const childActive = (child: DashboardNavChild) =>
                    pathname === child.href || pathname.startsWith(`${child.href}/`);
                  const groupActive = (item.children ?? []).some(childActive);
                  const selected =
                    item.href !== "#" &&
                    (item.children
                      ? groupActive
                      : isDashboardRoot
                        ? pathname === item.href
                        : isLibraryItem
                          ? pathname === item.href
                            || pathname.startsWith(`${item.href}/`)
                            || (activeOrg != null && (
                              pathname === getYourConnectionsRoute(activeOrg.slug)
                              || pathname.startsWith(`${getYourConnectionsRoute(activeOrg.slug)}/`)
                            ))
                          : pathname === item.href || pathname.startsWith(`${item.href}/`));

                  return (
                    <div key={item.label}>
                      <Link
                        href={item.href}
                        data-testid={item.testId}
                        onClick={() => setSidebarOpen(false)}
                        className={`flex min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[13px] tracking-[-0.1px] transition-colors ${
                          selected
                            ? "bg-gray-100 text-gray-900"
                            : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <item.icon className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                          <span className="min-w-0 truncate">{item.label}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {item.badge ? (
                            <span className="rounded-full bg-white px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                              {item.badge}
                            </span>
                          ) : null}
                          {item.children ? (
                            groupActive
                              ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" strokeWidth={2} />
                              : <ChevronRight className="h-3.5 w-3.5 text-gray-300" strokeWidth={2} />
                          ) : null}
                        </span>
                      </Link>
                      {item.children && groupActive ? (
                        <div className="ml-[22px] mt-1 min-w-0 space-y-0.5 border-l border-gray-100 pl-3">
                          {item.children.map((child) => (
                            <Link
                              key={child.label}
                              href={child.href}
                              onClick={() => setSidebarOpen(false)}
                              className={`flex min-w-0 items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-[13px] tracking-[-0.1px] transition-colors ${
                                childActive(child)
                                  ? "font-medium text-gray-900"
                                  : "text-gray-500 hover:text-gray-700"
                              }`}
                            >
                              <span className="min-w-0 truncate">{child.label}</span>
                              {child.badge ? (
                                <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-gray-500">
                                  {child.badge}
                                </span>
                              ) : null}
                            </Link>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="mt-auto shrink-0 p-3" data-testid="den-org-sidebar-footer">
        {orgSwitcher}

        {orgBusy ? (
          <p className="mt-3 px-2 text-[11px] text-gray-400">Refreshing workspace…</p>
        ) : null}
        {orgError ? (
          <p className="mt-3 px-2 text-[11px] font-medium text-rose-600">{orgError}</p>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#fafafa] md:h-screen md:flex-row">
      <WorkspaceFavicon metadata={orgContext?.organization.metadata} />
      {/* Desktop sidebar — always visible at md+ */}
      <aside className="hidden min-h-0 shrink-0 overflow-hidden border-r border-gray-100 bg-white md:flex md:h-screen md:w-[260px] md:flex-col">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar — off-canvas drawer */}
      {sidebarOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSidebarOpen(false)} aria-hidden />
          <aside className="relative z-10 flex h-full min-h-0 w-[280px] max-w-[85vw] flex-col overflow-hidden bg-white shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 bg-white px-4 md:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 md:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="text-[14px] tracking-[-0.1px] text-gray-900">
              {pageTitle}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {showFeedbackLink ? (
              <a
                href={feedbackHref}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
              >
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">Feedback</span>
              </a>
            ) : null}
            <a
              href={SOFIA_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
            >
              <FileText className="h-4 w-4" />
              <span className="hidden sm:inline">Docs</span>
            </a>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto bg-[#fafafa]">{children}</main>
      </div>

      {shouldShowProfilePrompt && user ? (
        <UserProfileDialog
          key={user.id}
          user={user}
          descriptor="Change how your name appears in the organization"
          onCancel={() => setProfilePromptDismissed(true)}
          onSave={async (input) => {
            await updateUserProfile(input);
            setProfilePromptDismissed(true);
          }}
        />
      ) : null}
    </div>
  );
}
