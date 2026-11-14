import { AutoUpdateCard } from "./_components/auto-update-card";
import { DatabaseBackupCard } from "./_components/database-backup-card";
import { GeneralSection } from "./_components/general-section";
import { PasswordSection } from "./_components/password-section";
import { SessionSection } from "./_components/session-section";
import { SystemSection } from "./_components/system-section";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <GeneralSection />
      <SystemSection />
      <AutoUpdateCard />
      <DatabaseBackupCard />
      <PasswordSection />
      <SessionSection />
    </div>
  );
}
