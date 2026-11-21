import { NextRequest, NextResponse } from 'next/server';

// Keeps the latest league snapshot in memory for the current server instance.
// For long-term multi-instance persistence on Vercel, swap this with Upstash Redis or a database.
let latestSnapshot: Record<string, unknown> | null = null;

export async function GET() {
  try {
    if (!latestSnapshot) {
      return NextResponse.json({ error: 'No snapshot saved yet' }, { status: 404 });
    }
    return NextResponse.json(latestSnapshot, { status: 200 });
  } catch (error) {
    console.error('GET /api/league/state failed:', error);
    return NextResponse.json({ error: 'Failed to load league state' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid league snapshot payload' }, { status: 400 });
    }
    latestSnapshot = body as Record<string, unknown>;
    return NextResponse.json(
      { ok: true, updated_at: (body as { updated_at?: string }).updated_at ?? null },
      { status: 200 }
    );
  } catch (error) {
    console.error('POST /api/league/state failed:', error);
    return NextResponse.json({ error: 'Failed to save league state' }, { status: 500 });
  }
}
