import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ error: "Leaderboard unavailable" }, { status: 410 });
}

export async function POST() {
  return NextResponse.json({ error: "Leaderboard unavailable" }, { status: 410 });
}
