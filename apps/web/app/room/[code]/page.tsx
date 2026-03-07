import { PageShell } from "@/components/PageShell";
import { RoomClient } from "@/components/RoomClient";

type RoomPageProps = {
  params: Promise<{
    code: string;
  }>;
  searchParams: Promise<{
    team?: string;
  }>;
};

export default async function RoomPage({ params, searchParams }: RoomPageProps) {
  const resolvedParams = await params;
  const resolvedSearch = await searchParams;

  const normalizedCode = (resolvedParams.code ?? "").trim();
  const validCode = /^\d{4}$/u.test(normalizedCode);

  const team = resolvedSearch.team;
  const preferredTeam = team === "A" || team === "B" ? team : null;

  return (
    <PageShell showHeader={false}>
      {validCode ? (
        <RoomClient roomCode={normalizedCode} preferredTeam={preferredTeam} />
      ) : (
        <section className="card">
          <p className="error">Invalid room code.</p>
        </section>
      )}
    </PageShell>
  );
}
