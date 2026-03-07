import { PageShell } from "@/components/PageShell";
import { SoloClient } from "@/components/SoloClient";

export default function SoloPage() {
  return (
    <PageShell showHeader={false}>
      <SoloClient />
    </PageShell>
  );
}
