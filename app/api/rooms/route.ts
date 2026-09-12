import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/neon";
import { generateSolution, PUZZLE_SIZES, type PuzzleSize } from "@/lib/puzzle-generator";

export const runtime = "edge";

type CellWriteOp = { index: number; value: number; expect?: number };

const validSizes = new Set<number>(PUZZLE_SIZES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z2-9]{8}$/.test(value);
}

function validSize(value: unknown): value is PuzzleSize {
  return typeof value === "number" && validSizes.has(value);
}

function validSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function validGrid(value: unknown, length: number, allowed: readonly number[]): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((cell) => typeof cell === "number" && allowed.includes(cell));
}

// The room row with presence folded in. `solution` is only serialized for
// legacy clients (pre-v2) that compute clues and win state from it; modern
// clients derive clues locally from size+seed and use `completed`.
function roomPayload(row: Record<string, unknown>, includeSolution: boolean) {
  const players = Array.isArray(row.players) ? (row.players as Record<string, unknown>[]) : [];
  const payload: Record<string, unknown> = {
    code: row.room_code,
    size: Number(row.size),
    seed: Number(row.puzzle_seed),
    cells: row.cells,
    revision: Number(row.revision),
    completed: Boolean(row.completed),
    elapsedSeconds: Number(row.elapsed_seconds ?? 0),
    players: players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      cursorIndex: player.cursorIndex === null || player.cursorIndex === undefined ? null : Number(player.cursorIndex),
    })),
  };
  if (includeSolution) payload.solution = row.solution;
  return payload;
}

function roomSelect(sql: ReturnType<typeof database>) {
  return sql`
    select room_code, size, puzzle_seed, revision, completed, cells, solution,
      coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds,
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', p.player_id, 'name', p.display_name, 'color', p.color, 'cursorIndex', p.cursor_index) order by p.last_seen desc), '[]'::jsonb)
        from nonogram_room_players p
        where p.room_code = nonogram_rooms.room_code and p.last_seen > now() - interval '25 seconds'
      ) as players
    from nonogram_rooms`;
}

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code")?.toUpperCase();
    if (!validCode(code)) return NextResponse.json({ error: "รหัสห้องไม่ถูกต้อง" }, { status: 400 });
    const revParam = request.nextUrl.searchParams.get("rev");
    const rev = revParam !== null && Number.isSafeInteger(Number(revParam)) ? Number(revParam) : null;
    const sql = database();
    const rows = await sql`${roomSelect(sql)} where room_code = ${code} limit 1`;
    if (!rows[0]) return NextResponse.json({ error: "ไม่พบห้องนี้" }, { status: 404 });
    if (rev !== null && Number(rows[0].revision) <= rev) return new NextResponse(null, { status: 204 });
    return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>, rev === null));
  } catch (error) {
    console.error("room read failed", error);
    return NextResponse.json({ error: "เชื่อมต่อฐานข้อมูลไม่สำเร็จ" }, { status: 500 });
  }
}

// Applies a batch of cell writes with per-op expected-value guards (used by
// multiplayer undo). Uses optimistic concurrency on `revision` instead of row
// locks, retrying when another writer committed first — concurrent strokes
// from different players then compose instead of overwriting each other.
async function applyCellOps(
  sql: ReturnType<typeof database>,
  code: string,
  seed: number,
  ops: CellWriteOp[],
  includeSolution: boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rooms = await sql`
      select room_code, size, puzzle_seed, revision, completed, cells, solution, started_at
      from nonogram_rooms where room_code = ${code} limit 1`;
    const row = rooms[0] as Record<string, unknown> | undefined;
    if (!row) return { status: 404, body: { error: "ไม่พบห้องนี้" } };
    if (Number(row.puzzle_seed) !== seed) return { status: 409, body: { error: "โจทย์ถูกเปลี่ยนแล้ว กรุณารอซิงก์" } };

    const bound = Number(row.size) * Number(row.size);
    const current = row.cells as number[];
    const next = current.slice();
    let changed = false;
    for (const op of ops) {
      if (!Number.isInteger(op.index) || op.index < 0 || op.index >= bound) continue;
      if (op.expect !== undefined && next[op.index] !== op.expect) continue;
      if (next[op.index] === op.value) continue;
      next[op.index] = op.value;
      changed = true;
    }

    if (!changed) {
      const fresh = await sql`${roomSelect(sql)} where room_code = ${code} limit 1`;
      if (!fresh[0]) return { status: 404, body: { error: "ไม่พบห้องนี้" } };
      return { status: 200, body: roomPayload(fresh[0] as Record<string, unknown>, includeSolution) };
    }

    const solution = row.solution as number[];
    const completed = solution.every((answer, index) => (answer === 1 ? next[index] === 1 : next[index] !== 1));
    const startsClock = row.started_at === null && ops.some((op) => op.value !== 0);
    const revision = Number(row.revision);
    const updated = startsClock
      ? await sql`
          update nonogram_rooms
          set cells = ${JSON.stringify(next)}::jsonb, revision = revision + 1, completed = ${completed},
              started_at = now(), updated_at = now()
          where room_code = ${code} and revision = ${revision}
          returning room_code, size, puzzle_seed, revision, completed, cells,
            coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds`
      : await sql`
          update nonogram_rooms
          set cells = ${JSON.stringify(next)}::jsonb, revision = revision + 1, completed = ${completed},
              updated_at = now()
          where room_code = ${code} and revision = ${revision}
          returning room_code, size, puzzle_seed, revision, completed, cells,
            coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds`;
    if (updated[0]) return { status: 200, body: roomPayload(updated[0] as Record<string, unknown>, includeSolution) };
  }
  return { status: 503, body: { error: "ซิงก์ชนกัน กรุณาลองอีกครั้ง" } };
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    if (!isRecord(rawBody)) return NextResponse.json({ error: "รูปแบบคำขอไม่ถูกต้อง" }, { status: 400 });
    const body = rawBody;
    const includeSolution = body.v !== 2;
    const sql = database();

    if (body.action === "create") {
      if (!validCode(body.code) || !validSize(body.size) || !validSeed(body.seed)) return NextResponse.json({ error: "ข้อมูลห้องไม่ถูกต้อง" }, { status: 400 });
      const expected = body.size * body.size;
      // The solution is derived server-side from the curated seed, so clients
      // can never install a doctored board.
      const solution = generateSolution(body.size, body.seed);
      const cells = validGrid(body.cells, expected, [0, 1, 2]) ? body.cells : Array(expected).fill(0);
      const rows = await sql`
        insert into nonogram_rooms (room_code, size, puzzle_seed, solution, cells)
        values (${body.code}, ${body.size}, ${body.seed}, ${JSON.stringify(solution)}::jsonb, ${JSON.stringify(cells)}::jsonb)
        on conflict (room_code) do nothing
        returning room_code, size, puzzle_seed, revision, completed, cells,
          coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds`;
      if (!rows[0]) return NextResponse.json({ error: "รหัสห้องซ้ำ กรุณาลองใหม่" }, { status: 409 });
      return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>, includeSolution));
    }

    if (!validCode(body.code)) return NextResponse.json({ error: "รหัสห้องไม่ถูกต้อง" }, { status: 400 });
    const code = body.code;

    if (body.action === "cells" || body.action === "cell") {
      const rawOps = body.action === "cell" ? [{ index: body.index, value: body.value }] : body.ops;
      if (!validSeed(body.seed) || !Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 2048) {
        return NextResponse.json({ error: "ข้อมูลช่องไม่ถูกต้อง" }, { status: 400 });
      }
      const ops: CellWriteOp[] = [];
      for (const raw of rawOps) {
        if (!isRecord(raw)) return NextResponse.json({ error: "ข้อมูลช่องไม่ถูกต้อง" }, { status: 400 });
        const index = Number(raw.index);
        const value = Number(raw.value);
        if (!Number.isInteger(index) || index < 0 || ![0, 1, 2].includes(value)) return NextResponse.json({ error: "ข้อมูลช่องไม่ถูกต้อง" }, { status: 400 });
        const expect = raw.expect === undefined ? undefined : Number(raw.expect);
        if (expect !== undefined && ![0, 1, 2].includes(expect)) return NextResponse.json({ error: "ข้อมูลช่องไม่ถูกต้อง" }, { status: 400 });
        ops.push({ index, value, expect });
      }
      const result = await applyCellOps(sql, code, body.seed, ops, includeSolution);
      return NextResponse.json(result.body, { status: result.status });
    }

    if (body.action === "replace") {
      if (!validSize(body.size) || !validSeed(body.seed)) return NextResponse.json({ error: "ข้อมูลเกมไม่ถูกต้อง" }, { status: 400 });
      const expected = body.size * body.size;
      const solution = generateSolution(body.size, body.seed);
      const cells = validGrid(body.cells, expected, [0, 1, 2]) ? body.cells : Array(expected).fill(0);
      const rows = await sql`
        update nonogram_rooms
        set size = ${body.size}, puzzle_seed = ${body.seed}, solution = ${JSON.stringify(solution)}::jsonb,
            cells = ${JSON.stringify(cells)}::jsonb, revision = revision + 1,
            completed = false, started_at = null, updated_at = now()
        where room_code = ${code}
        returning room_code, size, puzzle_seed, revision, completed, cells,
          coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds`;
      if (!rows[0]) return NextResponse.json({ error: "ไม่พบห้องนี้" }, { status: 404 });
      return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>, includeSolution));
    }

    if (body.action === "cursor") {
      const playerId = String(body.playerId || "").slice(0, 64);
      const cursor = body.cursor === null ? null : Number(body.cursor);
      const cursorValid = cursor === null || (Number.isInteger(cursor) && cursor >= 0 && cursor < 1024);
      if (!playerId || !cursorValid) return NextResponse.json({ error: "ข้อมูลเคอร์เซอร์ไม่ถูกต้อง" }, { status: 400 });
      await sql`
        update nonogram_room_players set cursor_index = ${cursor}
        where room_code = ${code} and player_id = ${playerId}`;
      return NextResponse.json({ ok: true });
    }

    if (body.action === "heartbeat") {
      const name = String(body.name || "ผู้เล่น").trim().slice(0, 24);
      const playerId = String(body.playerId || "").slice(0, 64);
      const color = String(body.color || "#3457d5").slice(0, 16);
      if (!playerId || !name) return NextResponse.json({ error: "ข้อมูลผู้เล่นไม่ครบ" }, { status: 400 });
      await sql`
        insert into nonogram_room_players (room_code, player_id, display_name, color, last_seen)
        values (${code}, ${playerId}, ${name}, ${color}, now())
        on conflict (room_code, player_id)
        do update set display_name = excluded.display_name, color = excluded.color, last_seen = now()`;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "ไม่รู้จักคำสั่งนี้" }, { status: 400 });
  } catch (error) {
    console.error("room write failed", error);
    return NextResponse.json({ error: "บันทึกเกมไม่สำเร็จ" }, { status: 500 });
  }
}
