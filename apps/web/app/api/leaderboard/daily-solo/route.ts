import { prisma } from "@word-hunt/db";
import { NextResponse } from "next/server";
import { getSofiaDateString } from "@/lib/time";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") ?? getSofiaDateString();

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  const dateValue = new Date(`${date}T00:00:00.000Z`);

  const entries = await prisma.dailySoloEntry.findMany({
    where: { date: dateValue },
    include: { user: true },
    orderBy: [{ turnsToSolve: "asc" }, { timeMs: "asc" }],
    take: 100
  });

  return NextResponse.json({
    date,
    entries: entries.map((entry) => ({
      userId: entry.userId,
      displayName: entry.user.displayName,
      turnsToSolve: entry.turnsToSolve,
      timeMs: entry.timeMs
    }))
  });
}
