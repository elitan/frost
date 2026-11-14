import { AutoUpdateCard } from "./_components/auto-update-card";
import { DatabaseBackupCard } from "./_components/database-backup-card";
import { PasswordSection } from "./_components/password-section";
import { SessionSection } from "./_components/session-section";
import { SystemSection } from "./_components/system-section";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <SystemSection />
      <AutoUpdateCard />
      <DatabaseBackupCard />
      <PasswordSection />
      <SessionSection />
    </div>
  );
}
