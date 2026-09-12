import { NextRequest } from "next/server";
import { database } from "@/lib/neon";
import { diffCells } from "@/lib/room-sync";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const TICK_MS = 400;
const HEARTBEAT_MS = 8_000;
const KEEPALIVE_MS = 5_000;
const STREAM_LIFETIME_MS = 25_000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function playersSignature(players: unknown[]) {
  return players.map((player) => {
    const record = player as Record<string, unknown>;
    return `${record.id}:${record.name}:${record.color}:${record.cursorIndex ?? ""}`;
  }).join("|");
}

// Server-sent-events room feed. Each tick runs one light query (revision +
// presence) and only fetches the full board when the revision moved, then
// pushes a compact diff. The stream self-closes before platform limits and
// EventSource reconnects automatically with a fresh full snapshot.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const code = (params.get("code") ?? "").toUpperCase();
  const playerId = (params.get("playerId") ?? "").slice(0, 64);
  const name = (params.get("name") ?? "").trim().slice(0, 24) || "ผู้เล่น";
  const color = (params.get("color") ?? "").slice(0, 16) || "#3457d5";
  if (!/^[A-Z2-9]{8}$/.test(code) || !playerId) return new Response("รหัสห้องไม่ถูกต้อง", { status: 400 });

  const sql = database();
  const encoder = new TextEncoder();
  let cancelled = false;

  const lightSelect = sql`
    select size, puzzle_seed, revision,
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', p.player_id, 'name', p.display_name, 'color', p.color, 'cursorIndex', p.cursor_index) order by p.last_seen desc), '[]'::jsonb)
        from nonogram_room_players p
        where p.room_code = nonogram_rooms.room_code and p.last_seen > now() - interval '25 seconds'
      ) as players
    from nonogram_rooms where room_code = ${code} limit 1`;

  const fullSelect = sql`
    select room_code, size, puzzle_seed, revision, completed, cells,
      coalesce(floor(extract(epoch from (now() - started_at))), 0) as elapsed_seconds,
      (
        select coalesce(jsonb_agg(jsonb_build_object('id', p.player_id, 'name', p.display_name, 'color', p.color, 'cursorIndex', p.cursor_index) order by p.last_seen desc), '[]'::jsonb)
        from nonogram_room_players p
        where p.room_code = nonogram_rooms.room_code and p.last_seen > now() - interval '25 seconds'
      ) as players
    from nonogram_rooms where room_code = ${code} limit 1`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        controller.enqueue(encoder.encode("retry: 800\n\n"));
        await sql`
          insert into nonogram_room_players (room_code, player_id, display_name, color, last_seen)
          values (${code}, ${playerId}, ${name}, ${color}, now())
          on conflict (room_code, player_id)
          do update set display_name = excluded.display_name, color = excluded.color, last_seen = now()`;

        const initial = (await fullSelect) as Array<Record<string, unknown>>;
        if (!initial[0]) {
          send("gone", { error: "ไม่พบห้องนี้" });
        } else {
          const first = initial[0];
          send("state", {
            code,
            size: Number(first.size),
            seed: Number(first.puzzle_seed),
            revision: Number(first.revision),
            completed: Boolean(first.completed),
            cells: first.cells,
            elapsedSeconds: Number(first.elapsed_seconds ?? 0),
            players: Array.isArray(first.players) ? first.players : [],
          });

          let lastRow = first;
          let lastBeat = Date.now();
          let lastSignal = Date.now();
          const deadline = Date.now() + STREAM_LIFETIME_MS;

          while (!cancelled && !request.signal.aborted && Date.now() < deadline) {
            await sleep(TICK_MS, request.signal);
            if (cancelled || request.signal.aborted) break;

            const tick = (await lightSelect) as Array<Record<string, unknown>>;
            if (!tick[0]) {
              send("gone", { error: "ไม่พบห้องนี้" });
              break;
            }
            const current = tick[0];
            const players = Array.isArray(current.players) ? current.players : [];
            const revision = Number(current.revision);
            const puzzleChanged = Number(current.size) !== Number(lastRow.size) || Number(current.puzzle_seed) !== Number(lastRow.puzzle_seed);

            if (revision !== Number(lastRow.revision)) {
              const full = (await fullSelect) as Array<Record<string, unknown>>;
              if (!full[0]) {
                send("gone", { error: "ไม่พบห้องนี้" });
                break;
              }
              const row = full[0];
              const rowPlayers = Array.isArray(row.players) ? row.players : [];
              if (puzzleChanged) {
                send("state", {
                  code,
                  size: Number(row.size),
                  seed: Number(row.puzzle_seed),
                  revision: Number(row.revision),
                  completed: Boolean(row.completed),
                  cells: row.cells,
                  elapsedSeconds: Number(row.elapsed_seconds ?? 0),
                  players: rowPlayers,
                });
              } else {
                send("patch", {
                  revision: Number(row.revision),
                  completed: Boolean(row.completed),
                  ops: diffCells(lastRow.cells as number[], row.cells as number[]),
                  players: rowPlayers,
                  elapsedSeconds: Number(row.elapsed_seconds ?? 0),
                });
              }
              lastRow = row;
            } else if (playersSignature(Array.isArray(lastRow.players) ? lastRow.players : []) !== playersSignature(players)) {
              send("players", players);
              lastRow = { ...lastRow, players };
            }

            const now = Date.now();
            if (now - lastBeat >= HEARTBEAT_MS) {
              await sql`update nonogram_room_players set last_seen = now() where room_code = ${code} and player_id = ${playerId}`;
              lastBeat = now;
            }
            if (now - lastSignal >= KEEPALIVE_MS) {
              // A real named event, not a comment: EventSource listeners on
              // the client can only observe events, and the connection
              // watchdog resets on them.
              send("ping", { t: now });
              lastSignal = now;
            }
          }
          if (!cancelled) send("bye", { ok: true });
        }
      } catch (error) {
        console.error("room stream failed", error);
        send("bye", { ok: false });
      }
      try {
        controller.close();
      } catch {
        // Client already went away.
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
