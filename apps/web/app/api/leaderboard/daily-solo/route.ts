import { prisma } from "@word-hunt/db";
import { DISPLAY_NAME_REGEX } from "@word-hunt/shared";
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

export async function POST(request: Request) {
  const body = (await request.json()) as {
    date?: string;
    userId?: string;
    displayName?: string;
    turnsToSolve?: number;
    timeMs?: number;
  };

  const date = body.date ?? getSofiaDateString();
  const displayName = body.displayName?.trim() ?? "";
  const turnsToSolve = body.turnsToSolve ?? 0;
  const timeMs = body.timeMs ?? 0;

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  if (!body.userId || !/^[0-9a-f-]{36}$/iu.test(body.userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  if (!DISPLAY_NAME_REGEX.test(displayName)) {
    return NextResponse.json(
      { error: "Use 2-20 chars with letters, numbers, space, _ or -" },
      { status: 400 }
    );
  }

  if (!Number.isInteger(turnsToSolve) || turnsToSolve <= 0) {
    return NextResponse.json({ error: "Invalid guess count" }, { status: 400 });
  }

  if (!Number.isInteger(timeMs) || timeMs < 0) {
    return NextResponse.json({ error: "Invalid time" }, { status: 400 });
  }

  const dateValue = new Date(`${date}T00:00:00.000Z`);

  await prisma.user.upsert({
    where: { id: body.userId },
    create: {
      id: body.userId,
      displayName
    },
    update: {
      displayName
    }
  });

  await prisma.dailySoloEntry.upsert({
    where: {
      date_userId: {
        date: dateValue,
        userId: body.userId
      }
    },
    create: {
      date: dateValue,
      userId: body.userId,
      turnsToSolve,
      timeMs
    },
    update: {
      turnsToSolve,
      timeMs
    }
  });

  return NextResponse.json({ ok: true });
}
