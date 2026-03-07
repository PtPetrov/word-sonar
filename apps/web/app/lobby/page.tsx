import { PageShell } from "@/components/PageShell";
import { LobbyClient } from "@/components/LobbyClient";

export default function LobbyPage() {
  return (
    <PageShell showHeader={false}>
      <LobbyClient />
    </PageShell>
  );
}
