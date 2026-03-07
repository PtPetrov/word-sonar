import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "web",
    dictionaryVersion: process.env.NEXT_PUBLIC_DICTIONARY_VERSION ?? null
  });
}
