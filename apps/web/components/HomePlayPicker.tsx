import Link from "next/link";

export function HomePlayPicker() {
  return (
    <div className="home-actions">
      <Link href="/solo" className="button primary big home-primary-action">
        Play Solo
      </Link>
      <Link href="/lobby" className="button secondary big home-primary-action">
        Play 1v1
      </Link>
    </div>
  );
}
