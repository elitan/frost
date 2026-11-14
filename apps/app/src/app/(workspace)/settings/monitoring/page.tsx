"use client";

import { useState } from "react";
import {
  useMonitoringHistory,
  useMonitoringStats,
} from "@/hooks/use-monitoring";
import { SettingsPageHeader } from "../_components/settings-page-header";
import { getNavItem } from "../_components/settings-sidebar";
import { SystemOverview } from "./_components/system-overview";
import { TimeRangeSelector } from "./_components/time-range-selector";

const navItem = getNavItem("monitoring");

export default function MonitoringPage() {
  const [range, setRange] = useState("1h");
  const { data: snapshot, isLoading: statsLoading } = useMonitoringStats();
  const { data: history, isLoading: historyLoading } =
    useMonitoringHistory(range);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={navItem.label}
        description={navItem.description}
        action={<TimeRangeSelector value={range} onChange={setRange} />}
      />

      <SystemOverview
        snapshot={snapshot}
        history={history}
        isLoading={statsLoading || historyLoading}
      />
    </div>
  );
}
