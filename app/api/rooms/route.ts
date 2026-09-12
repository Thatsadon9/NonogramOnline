import { NextRequest, NextResponse } from "next/server";
import { database } from "@/lib/neon";

export const runtime = "edge";

type Cell = 0 | 1 | 2;
const validSizes = new Set([5, 10, 15, 20, 25]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z2-9]{8}$/.test(value);
}

function validSize(value: unknown): value is number {
  return typeof value === "number" && validSizes.has(value);
}

function validSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validGrid(value: unknown, length: number, allowed: readonly number[]): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((cell) => typeof cell === "number" && allowed.includes(cell));
}

function roomPayload(row: Record<string, unknown>, players?: Record<string, unknown>[]) {
  return {
    code: row.room_code,
    size: Number(row.size),
    seed: Number(row.puzzle_seed),
    solution: row.solution,
    cells: row.cells,
    revision: Number(row.revision),
    completed: Boolean(row.completed),
    updatedAt: row.updated_at,
    players: players?.map((player) => ({
      id: player.player_id,
      name: player.display_name,
      color: player.color,
    })),
  };
}

export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code")?.toUpperCase();
    if (!validCode(code)) return NextResponse.json({ error: "รหัสห้องไม่ถูกต้อง" }, { status: 400 });
    const sql = database();
    const [rooms, players] = await sql.transaction([
      sql`select * from nonogram_rooms where room_code = ${code} limit 1`,
      sql`select player_id, display_name, color from nonogram_room_players
          where room_code = ${code} and last_seen > now() - interval '25 seconds'
          order by last_seen desc`,
    ]);
    if (!rooms[0]) return NextResponse.json({ error: "ไม่พบห้องนี้" }, { status: 404 });
    return NextResponse.json(roomPayload(rooms[0] as Record<string, unknown>, players as Record<string, unknown>[]));
  } catch (error) {
    console.error("room read failed", error);
    return NextResponse.json({ error: "เชื่อมต่อฐานข้อมูลไม่สำเร็จ" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.json();
    if (!isRecord(rawBody)) return NextResponse.json({ error: "รูปแบบคำขอไม่ถูกต้อง" }, { status: 400 });
    const body = rawBody;
    const sql = database();

    if (body.action === "create") {
      if (!validCode(body.code) || !validSize(body.size) || !validSeed(body.seed)) return NextResponse.json({ error: "ข้อมูลห้องไม่ถูกต้อง" }, { status: 400 });
      const expected = body.size * body.size;
      if (!validGrid(body.solution, expected, [0, 1]) || !validGrid(body.cells, expected, [0, 1, 2])) {
        return NextResponse.json({ error: "ข้อมูลตารางไม่ครบ" }, { status: 400 });
      }
      const rows = await sql`
        insert into nonogram_rooms (room_code, size, puzzle_seed, solution, cells)
        values (${body.code}, ${body.size}, ${body.seed}, ${JSON.stringify(body.solution)}::jsonb, ${JSON.stringify(body.cells)}::jsonb)
        on conflict (room_code) do nothing
        returning *`;
      if (!rows[0]) return NextResponse.json({ error: "รหัสห้องซ้ำ กรุณาลองใหม่" }, { status: 409 });
      return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>));
    }

    if (!validCode(body.code)) return NextResponse.json({ error: "รหัสห้องไม่ถูกต้อง" }, { status: 400 });
    const code = body.code;

    if (body.action === "cell") {
      const index = Number(body.index);
      const value = Number(body.value) as Cell;
      if (!validSeed(body.seed) || !Number.isInteger(index) || index < 0 || ![0, 1, 2].includes(value)) return NextResponse.json({ error: "ข้อมูลช่องไม่ถูกต้อง" }, { status: 400 });
      const path = [String(index)];
      const rows = await sql`
        update nonogram_rooms
        set cells = jsonb_set(cells, ${path}::text[], to_jsonb(${value}::int), false),
            revision = revision + 1,
            completed = not exists (
              select 1
              from generate_series(0, size * size - 1) as positions(index)
              where ((solution ->> positions.index)::int = 1)
                <> ((jsonb_set(cells, ${path}::text[], to_jsonb(${value}::int), false) ->> positions.index)::int = 1)
            ),
            updated_at = now()
        where room_code = ${code} and puzzle_seed = ${body.seed} and ${index} < size * size
        returning *`;
      if (!rows[0]) return NextResponse.json({ error: "โจทย์ถูกเปลี่ยนแล้ว กรุณารอซิงก์" }, { status: 409 });
      return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>));
    }

    if (body.action === "replace") {
      if (!validSize(body.size) || !validSeed(body.seed)) return NextResponse.json({ error: "ข้อมูลเกมไม่ถูกต้อง" }, { status: 400 });
      const expected = body.size * body.size;
      if (!validGrid(body.solution, expected, [0, 1]) || !validGrid(body.cells, expected, [0, 1, 2])) return NextResponse.json({ error: "ข้อมูลตารางไม่ครบ" }, { status: 400 });
      const rows = await sql`
        update nonogram_rooms
        set size = ${body.size}, puzzle_seed = ${body.seed}, solution = ${JSON.stringify(body.solution)}::jsonb,
            cells = ${JSON.stringify(body.cells)}::jsonb, revision = revision + 1,
            completed = false, updated_at = now()
        where room_code = ${code}
        returning *`;
      if (!rows[0]) return NextResponse.json({ error: "ไม่พบห้องนี้" }, { status: 404 });
      return NextResponse.json(roomPayload(rows[0] as Record<string, unknown>));
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
