import { useState } from "react";
import { useVault } from "@/lib/vault";
import { apiPost } from "@/lib/api";

const PERSONAL_TEXT =
  "Skiff saves the commands you run on your servers and what they print, so you can search them later from History. " +
  "It tries to redact passwords and tokens before saving, everything is stored encrypted on this machine, and nothing is installed on your servers. " +
  "You can forget any entry, and turn Memory off in Settings.";

const TEAM_TEXT =
  "Skiff saves the commands you run on your servers and what they print. You and your team's admins can see them in History. " +
  "It tries to redact passwords and tokens before saving, and stores everything encrypted. " +
  "You can forget your own entries; admins control whether Memory is on.";

/** One-time explanation of Memory, shown on the first connection while Memory is on. */
export function MemoryNotice({ memoryOnForHost }: { memoryOnForHost: boolean }) {
  const { status, fetchStatus } = useVault();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !memoryOnForHost || !status?.memoryEnabled || status.memoryNoticeSeen !== false) return null;

  const gotIt = async () => {
    setDismissed(true);
    try {
      await apiPost("/api/memory/notice-seen");
      await fetchStatus();
    } catch {
      setDismissed(false);
    }
  };

  return (
    <div className="memnotice" role="note" aria-label="About Memory">
      <div className="memnotice__title">Skiff now remembers your commands</div>
      <div className="memnotice__text">{status.mode === "team" ? TEAM_TEXT : PERSONAL_TEXT}</div>
      <div className="memnotice__actions">
        <button type="button" className="btn btn--primary" onClick={gotIt}>Got it</button>
      </div>
    </div>
  );
}
