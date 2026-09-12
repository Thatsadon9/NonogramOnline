"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Grid3X3, Hand, LogIn, Pencil, Plus, Redo2, RotateCcw, Share2, Undo2, Users, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CellButton, type CellHandlers } from "@/components/game/cell";
import { ClueButton } from "@/components/game/clue-button";
import { TimeDisplay } from "@/components/game/time-display";
import { generateSolution, pickPuzzleSeed, PUZZLE_SEEDS, PUZZLE_SIZES, type PuzzleSize } from "@/lib/puzzle-generator";
import { autoCompletedKeys, computeColClues, computeRowClues, isSolvedByClues, type CellValue } from "@/lib/nonogram";
import { acceptsRevision, mergePendingCells, type PendingCell } from "@/lib/room-sync";
import { RoomClient, type Player, type RoomPatch, type RoomSnapshot, type RoomStatus } from "@/lib/room-client";
import { progress } from "@/lib/progress";
import { playTick, playWin, setSfxEnabled, sfxEnabled, vibrateTick } from "@/lib/sfx";

type BatchOp = { id: number; index: number; before: CellValue; after: CellValue };
type Stroke = { id: number; ops: BatchOp[]; acked: boolean };
type ClueProgress = { puzzleKey: string; completed: Set<string> };
type ErrorResponse = { error?: string };

const COLORS = ["#3457D5", "#E4572E", "#138A72", "#8A4FFF", "#DB8B00"];
const INITIAL_SEED = PUZZLE_SEEDS[10][9];
const EMPTY_COMPLETED_CLUES = new Set<string>();

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

function playerIdentity(): Player {
  if (typeof window === "undefined") return { id: "", name: "ผู้เล่น", color: COLORS[0], cursorIndex: null };
  let id = localStorage.getItem("nonogram-player-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("nonogram-player-id", id); }
  return { id, name: localStorage.getItem("nonogram-player-name") || `ผู้เล่น ${id.slice(0, 3)}`, color: COLORS[Number.parseInt(id.slice(-2), 16) % COLORS.length] || COLORS[0], cursorIndex: null };
}

function formatSeconds(total: number) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [size, setSize] = useState<PuzzleSize>(10);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [cells, setCells] = useState<CellValue[]>(() => Array(100).fill(0));
  const [historyStack, setHistoryStack] = useState<CellValue[][]>([]);
  const [future, setFuture] = useState<CellValue[][]>([]);
  const [room, setRoom] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roomOpen, setRoomOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<RoomStatus | "idle">("idle");
  const [notice, setNotice] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [started, setStarted] = useState(false);
  const [serverElapsed, setServerElapsed] = useState(0);
  const [clueProgress, setClueProgress] = useState<ClueProgress>(() => ({
    puzzleKey: `10:${INITIAL_SEED}`,
    completed: new Set(),
  }));
  const [strokeStack, setStrokeStack] = useState<Stroke[]>([]);
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [paintLock, setPaintLock] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [bestRecord, setBestRecord] = useState<{ key: string; value: number | null } | null>(null);
  const [me, setMe] = useState<Player>({ id: "", name: "ผู้เล่น", color: COLORS[0], cursorIndex: null });

  const identity = useRef<Player>({ id: "", name: "ผู้เล่น", color: COLORS[0], cursorIndex: null });
  const roomRef = useRef("");
  const seedRef = useRef(seed);
  const cellsRef = useRef(cells);
  const serverCellsRef = useRef(cells);
  const revisionRef = useRef(0);
  const mutationIdRef = useRef(0);
  const strokeIdRef = useRef(0);
  const pendingCellsRef = useRef(new Map<number, PendingCell<CellValue>>());
  const batchRef = useRef(new Map<number, BatchOp>());
  const roomClientRef = useRef<RoomClient | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const dragRef = useRef(false);
  const dragValueRef = useRef<CellValue>(1);
  const solvedRef = useRef(false);
  const paintLockRef = useRef(false);

  const solution = useMemo(() => generateSolution(size, seed), [size, seed]);
  const rowClues = useMemo(() => computeRowClues(solution, size), [solution, size]);
  const colClues = useMemo(() => computeColClues(solution, size), [solution, size]);
  const puzzleKey = `${size}:${seed}`;
  const completedClues = clueProgress.puzzleKey === puzzleKey ? clueProgress.completed : EMPTY_COMPLETED_CLUES;
  const autoKeys = useMemo(() => autoCompletedKeys(cells, rowClues, colClues, size), [cells, rowClues, colClues, size]);
  const solved = useMemo(() => isSolvedByClues(cells, rowClues, colClues, size), [cells, rowClues, colClues, size]);
  const peerCursors = useMemo(() => {
    const cursors = new Map<number, string>();
    if (!room) return cursors;
    for (const player of players) {
      if (player.id !== me.id && player.cursorIndex !== null && player.cursorIndex >= 0) cursors.set(player.cursorIndex, player.color);
    }
    return cursors;
  }, [room, players, me.id]);
  const bestSeconds = bestRecord?.key === puzzleKey ? bestRecord.value : progress.loadBestTime(puzzleKey);
  const sizeRef = useRef(size);
  const puzzleKeyRef = useRef(puzzleKey);
  const rowCluesRef = useRef(rowClues);
  const colCluesRef = useRef(colClues);
  const elapsedRef = useRef(0);

  useEffect(() => {
    identity.current = playerIdentity();
    setMe(identity.current);
    setDisplayName(identity.current.name);
    try {
      setPaintLock(localStorage.getItem("nonogram-paint-lock") === "1");
    } catch { /* private mode */ }
    setSoundOn(sfxEnabled());
    const urlRoom = new URLSearchParams(location.search).get("room");
    if (urlRoom) { setJoinCode(urlRoom.toUpperCase()); setRoomOpen(true); return; }
    const stored = progress.loadProgress(`10:${INITIAL_SEED}`);
    if (stored && stored.cells.length === 100) {
      const restored = stored.cells.map((value) => (value === 1 || value === 2 ? value : 0) as CellValue);
      cellsRef.current = restored;
      serverCellsRef.current = restored;
      setCells(restored);
      setElapsed(stored.elapsed);
      setStarted(stored.started);
    }
  }, []);

  useEffect(() => { solvedRef.current = solved; }, [solved]);
  useEffect(() => { paintLockRef.current = paintLock; }, [paintLock]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { puzzleKeyRef.current = puzzleKey; }, [puzzleKey]);
  useEffect(() => { rowCluesRef.current = rowClues; }, [rowClues]);
  useEffect(() => { colCluesRef.current = colClues; }, [colClues]);
  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);

  const timerRunning = !solved && (room ? serverElapsed > 0 : started);
  useEffect(() => {
    if (!timerRunning) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [timerRunning]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Solo progress survives reloads; rooms already persist on the server.
  useEffect(() => {
    if (room || solved || !started) return;
    const timer = setTimeout(() => progress.saveProgress(puzzleKey, { cells: cellsRef.current, elapsed, started: true }), 400);
    return () => clearTimeout(timer);
  }, [cells, elapsed, started, room, solved, puzzleKey]);

  const syncServerElapsed = useCallback((value: number) => {
    setServerElapsed(value);
    // The room clock is server-authoritative; local ticks only fill the gap
    // between patches and are corrected when they drift too far apart.
    if (value > 0) setElapsed((current) => (Math.abs(current - value) > 3 ? value : current));
  }, []);

  const announceSolved = useCallback(() => {
    playWin();
    if (roomRef.current) return;
    progress.clearProgress(puzzleKeyRef.current);
    const result = progress.recordBestTime(puzzleKeyRef.current, elapsedRef.current);
    setBestRecord({ key: puzzleKeyRef.current, value: result.best });
    if (result.previous !== null && result.best < result.previous) toast.success(`สถิติใหม่ ${formatSeconds(result.best)}!`);
  }, []);

  // Single funnel for board updates: applies cells and fires the one-time
  // "solved" celebration (sound, best time, cleanup) on the transition, from
  // whichever path completed the board — local paint, remote patch, or redo.
  const commitCells = useCallback((next: CellValue[]) => {
    cellsRef.current = next;
    setCells(next);
    if (!solvedRef.current && isSolvedByClues(next, rowCluesRef.current, colCluesRef.current, sizeRef.current)) {
      solvedRef.current = true;
      announceSolved();
    }
  }, [announceSolved]);

  const renderServerWithPending = useCallback(() => {
    commitCells(mergePendingCells(serverCellsRef.current, pendingCellsRef.current));
  }, [commitCells]);

  const applySnapshot = useCallback((data: RoomSnapshot, force = false) => {
    if (!force && !acceptsRevision(revisionRef.current, data.revision)) return false;
    revisionRef.current = data.revision;
    seedRef.current = data.seed;
    serverCellsRef.current = data.cells as CellValue[];
    setSize(data.size as PuzzleSize);
    setSeed(data.seed);
    syncServerElapsed(data.elapsedSeconds ?? 0);
    renderServerWithPending();
    if ((data.elapsedSeconds ?? 0) > 0 || data.cells.some(Boolean) || pendingCellsRef.current.size) setStarted(true);
    return true;
  }, [renderServerWithPending, syncServerElapsed]);

  const applyPatch = useCallback((patch: RoomPatch) => {
    if (!acceptsRevision(revisionRef.current, patch.revision)) return;
    revisionRef.current = patch.revision;
    const next = serverCellsRef.current.slice();
    for (const op of patch.ops) {
      if (op.index >= 0 && op.index < next.length) next[op.index] = op.value as CellValue;
    }
    serverCellsRef.current = next;
    if (patch.elapsedSeconds > 0) syncServerElapsed(patch.elapsedSeconds);
    renderServerWithPending();
  }, [renderServerWithPending, syncServerElapsed]);

  useEffect(() => {
    if (!room || !identity.current.id) return;
    const connectedAt = Date.now();
    const knownPlayers = new Map<string, string>();
    let previousStatus: RoomStatus = "connecting";

    const updatePlayers = (list: Player[]) => {
      const ready = Date.now() - connectedAt > 2500;
      if (ready) {
        for (const player of list) {
          if (player.id !== identity.current.id && !knownPlayers.has(player.id)) toast(`${player.name} เข้าห้องแล้ว`);
        }
        for (const [id, name] of knownPlayers) {
          if (id !== identity.current.id && !list.some((player) => player.id === id)) toast(`${name} ออกจากห้องแล้ว`);
        }
      }
      knownPlayers.clear();
      for (const player of list) knownPlayers.set(player.id, player.name);
      setPlayers(list);
    };

    const client = new RoomClient({
      code: room,
      identity: { id: identity.current.id, name: identity.current.name, color: identity.current.color },
      onSnapshot: (snapshot) => {
        applySnapshot(snapshot);
        if (snapshot.players) updatePlayers(snapshot.players);
      },
      onPatch: applyPatch,
      onPlayers: updatePlayers,
      onStatus: (status) => {
        if (status === "live" && previousStatus === "offline" && Date.now() - connectedAt > 2500) toast.success("กลับมาเชื่อมต่อแล้ว");
        previousStatus = status;
        setConnStatus(status);
      },
    });
    roomClientRef.current = client;
    client.connect();
    return () => {
      client.stop();
      roomClientRef.current = null;
      setPlayers([]);
      setConnStatus("idle");
    };
  }, [room, applySnapshot, applyPatch]);

  const resetSyncState = useCallback(() => {
    pendingCellsRef.current.clear();
    batchRef.current.clear();
    setPendingCount(0);
    setStrokeStack([]);
    setRedoStack([]);
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    retryDelayRef.current = 1000;
  }, []);

  const flushRoomBatchRef = useRef<() => void>(() => {});
  const paintRef = useRef<(index: number, value?: CellValue, remember?: boolean) => void>(() => {});

  // A whole drag stroke syncs as one atomic batch — one request, one revision
  // bump — and becomes a natural undo unit once the server acknowledges it.
  const flushRoomBatch = () => {
    const roomCode = roomRef.current;
    if (!roomCode || batchRef.current.size === 0) return;
    const ops = Array.from(batchRef.current.values());
    batchRef.current.clear();
    const strokeId = ++strokeIdRef.current;
    setStrokeStack((stack) => [...stack.slice(-49), { id: strokeId, ops, acked: false }]);
    setRedoStack([]);

    const puzzleSeed = seedRef.current;
    roomClientRef.current?.sendCells(ops.map((op) => ({ index: op.index, value: op.after })), puzzleSeed)
      .then((response) => {
        if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;
        for (const op of ops) {
          if (pendingCellsRef.current.get(op.index)?.id === op.id) pendingCellsRef.current.delete(op.index);
        }
        setPendingCount(pendingCellsRef.current.size);
        setStrokeStack((stack) => stack.map((stroke) => (stroke.id === strokeId ? { ...stroke, acked: true } : stroke)));
        retryDelayRef.current = 1000;
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        if (!response || !applySnapshot(response)) renderServerWithPending();
      })
      .catch(() => {
        if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;
        // Keep the optimistic overlay and retry the same batch with backoff.
        for (const op of ops) {
          if (pendingCellsRef.current.get(op.index)?.id === op.id) batchRef.current.set(op.index, op);
        }
        setPendingCount(pendingCellsRef.current.size);
        if (retryDelayRef.current === 1000) setNotice("รอเชื่อมต่อ — จะซิงก์ให้อัตโนมัติ");
        retryDelayRef.current = Math.min(5000, retryDelayRef.current * 2);
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; flushRoomBatchRef.current(); }, retryDelayRef.current);
      });
  };

  const scheduleFlush = () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => { flushTimerRef.current = null; flushRoomBatchRef.current(); }, 150);
  };

  const flushNow = () => {
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    flushRoomBatchRef.current();
  };

  const queueRoomCell = (index: number, before: CellValue, after: CellValue) => {
    const id = ++mutationIdRef.current;
    pendingCellsRef.current.set(index, { id, value: after });
    batchRef.current.set(index, { id, index, before, after });
    setPendingCount(pendingCellsRef.current.size);
    scheduleFlush();
  };

  const paint = (index: number, value?: CellValue, remember = true) => {
    const current = cellsRef.current;
    if (solvedRef.current || index < 0 || index >= current.length) return;
    const nextValue = value ?? ((current[index] + 1) % 3) as CellValue;
    if (current[index] === nextValue) return;
    const next = current.slice();
    next[index] = nextValue;
    if (roomRef.current) {
      queueRoomCell(index, current[index], nextValue);
    } else {
      if (remember) { setHistoryStack((items) => [...items.slice(-39), current]); setFuture([]); }
      setStarted(true);
    }
    commitCells(next);
    if (nextValue !== 0) { playTick(nextValue); vibrateTick(); }
  };

  useEffect(() => { flushRoomBatchRef.current = flushRoomBatch; });
  useEffect(() => { paintRef.current = paint; });

  // Room undo/redo replays a stroke's inverse; per-op expected values make it
  // skip cells a teammate has since repainted, instead of fighting them.
  const replayStroke = (ops: BatchOp[], forward: boolean) => {
    const roomCode = roomRef.current;
    const puzzleSeed = seedRef.current;
    const applicable = ops.filter((op) => cellsRef.current[op.index] === (forward ? op.before : op.after));
    const pendingIds = new Map<number, number>();
    if (applicable.length) {
      const next = cellsRef.current.slice();
      for (const op of applicable) {
        const target = forward ? op.after : op.before;
        next[op.index] = target;
        const id = ++mutationIdRef.current;
        pendingIds.set(op.index, id);
        pendingCellsRef.current.set(op.index, { id, value: target });
      }
      commitCells(next);
      setPendingCount(pendingCellsRef.current.size);
    }
    if (!applicable.length || !roomClientRef.current) return;

    roomClientRef.current.sendCells(
      applicable.map((op) => ({ index: op.index, value: forward ? op.after : op.before, expect: forward ? op.before : op.after })),
      puzzleSeed,
    ).then((response) => {
      if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;
      for (const op of applicable) {
        const pendingId = pendingIds.get(op.index);
        if (pendingId !== undefined && pendingCellsRef.current.get(op.index)?.id === pendingId) pendingCellsRef.current.delete(op.index);
      }
      setPendingCount(pendingCellsRef.current.size);
      if (!response || !applySnapshot(response)) renderServerWithPending();
    }).catch(() => {
      if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;
      for (const op of applicable) {
        const pendingId = pendingIds.get(op.index);
        if (pendingId !== undefined && pendingCellsRef.current.get(op.index)?.id === pendingId) pendingCellsRef.current.delete(op.index);
      }
      setPendingCount(pendingCellsRef.current.size);
      renderServerWithPending();
      setNotice("ย้อนกลับไม่สำเร็จ ลองอีกครั้ง");
    });
  };

  const undo = () => {
    if (roomRef.current) {
      for (let i = strokeStack.length - 1; i >= 0; i--) {
        const stroke = strokeStack[i]!;
        if (!stroke.acked) continue;
        setStrokeStack((stack) => stack.slice(0, i));
        setRedoStack((stack) => [...stack, stroke]);
        replayStroke(stroke.ops, false);
        return;
      }
      return;
    }
    const previous = historyStack.at(-1);
    if (!previous) return;
    setFuture((items) => [cellsRef.current, ...items]);
    commitCells(previous);
    setHistoryStack((items) => items.slice(0, -1));
  };

  const redo = () => {
    if (roomRef.current) {
      const stroke = redoStack.at(-1);
      if (!stroke) return;
      setRedoStack((stack) => stack.slice(0, -1));
      setStrokeStack((stack) => [...stack, stroke]);
      replayStroke(stroke.ops, true);
      return;
    }
    const next = future[0];
    if (!next) return;
    setHistoryStack((items) => [...items, cellsRef.current]);
    commitCells(next);
    setFuture((items) => items.slice(1));
  };

  const replacePuzzle = async (nextSize: PuzzleSize) => {
    const randomValue = crypto.getRandomValues(new Uint32Array(1))[0];
    const nextSeed = pickPuzzleSeed(nextSize, randomValue, nextSize === size ? seed : undefined);
    const nextCells: CellValue[] = Array(nextSize * nextSize).fill(0);

    if (roomRef.current) {
      setNotice("กำลังเปลี่ยนโจทย์…");
      try {
        const data = await roomClientRef.current?.replace(nextSize, nextSeed, nextCells);
        if (!data) { setNotice("เปลี่ยนโจทย์ไม่สำเร็จ"); return; }
        resetSyncState();
        applySnapshot(data, true);
        setElapsed(0);
        setStarted(false);
        setNotice("");
      } catch { setNotice("เปลี่ยนโจทย์ไม่สำเร็จ"); }
      return;
    }

    progress.clearProgress(puzzleKey);
    seedRef.current = nextSeed;
    cellsRef.current = nextCells;
    serverCellsRef.current = nextCells;
    setSize(nextSize);
    setSeed(nextSeed);
    setCells(nextCells);
    setHistoryStack([]);
    setFuture([]);
    setElapsed(0);
    setStarted(false);
  };

  const createRoom = async () => {
    setNotice("กำลังสร้างห้อง…");
    const roomCode = makeCode();
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", v: 2, code: roomCode, size, seed, cells: cellsRef.current }),
    });
    if (!response.ok) { const data = await readJson<ErrorResponse>(response); setNotice(data.error || "สร้างห้องไม่สำเร็จ"); return; }
    identity.current.name = displayName.trim() || identity.current.name;
    setMe({ ...identity.current });
    localStorage.setItem("nonogram-player-name", identity.current.name);
    roomRef.current = roomCode;
    revisionRef.current = -1;
    serverCellsRef.current = cellsRef.current;
    resetSyncState();
    setHistoryStack([]);
    setFuture([]);
    setElapsed(0);
    setRoom(roomCode);
    setRoomOpen(false);
    setNotice("");
    window.history.replaceState(null, "", `?room=${roomCode}`);
  };

  const joinRoom = async () => {
    const target = joinCode.trim().toUpperCase();
    setNotice("กำลังเข้าห้อง…");
    const response = await fetch(`/api/rooms?code=${encodeURIComponent(target)}`, { cache: "no-store" });
    if (!response.ok) { const data = await readJson<ErrorResponse>(response); setNotice(data.error || "เข้าห้องไม่สำเร็จ"); return; }
    const data = await readJson<RoomSnapshot>(response);
    identity.current.name = displayName.trim() || identity.current.name;
    setMe({ ...identity.current });
    localStorage.setItem("nonogram-player-name", identity.current.name);
    roomRef.current = target;
    revisionRef.current = data.revision;
    resetSyncState();
    setHistoryStack([]);
    setFuture([]);
    setElapsed(data.elapsedSeconds ?? 0);
    setStarted(false);
    applySnapshot(data, true);
    setRoom(target);
    setRoomOpen(false);
    setNotice("");
    window.history.replaceState(null, "", `?room=${target}`);
  };

  const shareRoom = async () => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room}`);
    setNotice("คัดลอกลิงก์ห้องแล้ว");
  };

  const toggleClue = useCallback((key: string) => {
    setClueProgress((current) => {
      const next = new Set(current.puzzleKey === puzzleKey ? current.completed : undefined);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { puzzleKey, completed: next };
    });
  }, [puzzleKey]);

  const togglePaintLock = () => {
    setPaintLock((current) => {
      const next = !current;
      paintLockRef.current = next;
      try { localStorage.setItem("nonogram-paint-lock", next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };

  const toggleSound = () => {
    setSoundOn((current) => {
      const next = !current;
      setSfxEnabled(next);
      return next;
    });
  };

  const endDrag = () => {
    if (dragRef.current) {
      dragRef.current = false;
      flushNow();
    }
    if (roomRef.current) roomClientRef.current?.sendCursor(null);
  };

  const cellHandlers = useMemo<CellHandlers>(() => ({
    onPaintDown: (index, event) => {
      if (event.button !== 0) return;
      // On touch, painting requires the paint-lock toggle so the board stays
      // scrollable by default; mouse and pen always paint.
      if (event.pointerType === "touch" && !paintLockRef.current) return;
      event.preventDefault();
      const value = ((cellsRef.current[index]! + 1) % 3) as CellValue;
      dragRef.current = true;
      dragValueRef.current = value;
      paintRef.current(index, value, true);
    },
    onPaintEnter: (index, event) => {
      if (roomRef.current && event.pointerType === "mouse") roomClientRef.current?.sendCursor(index);
      if (dragRef.current) paintRef.current(index, dragValueRef.current, false);
    },
    onPaintMenu: (index, event) => {
      event.preventDefault();
      paintRef.current(index, cellsRef.current[index] === 2 ? 0 : 2);
    },
  }), []);

  const statusText = !room
    ? "เล่นคนเดียว"
    : notice
      || (pendingCount > 0 ? "กำลังซิงก์…" : connStatus === "live" ? "ออนไลน์" : connStatus === "connecting" ? "กำลังเชื่อมต่อ…" : "รอเชื่อมต่อ…");
  const canUndo = room ? strokeStack.some((stroke) => stroke.acked) : historyStack.length > 0;
  const canRedo = room ? redoStack.length > 0 : future.length > 0;

  const cellSize = size <= 5 ? 52 : size <= 10 ? 38 : size <= 15 ? 29 : size <= 20 ? 24 : 21;
  const boardStyle = { "--cell": `${cellSize}px`, "--rows": size, "--cols": size, "--row-clues": Math.max(...rowClues.map((item) => item.length)), "--col-clues": Math.max(...colClues.map((item) => item.length)) } as React.CSSProperties;

  return (
    <main className="game-shell" onPointerUp={endDrag} onPointerLeave={endDrag}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Nonogram Together หน้าแรก"><span className="brand-mark"><Grid3X3 /></span><span>NONOGRAM <b>TOGETHER</b></span></a>
        <div className="top-actions">
          <span className={`sync-state ${room ? "online" : ""}`}><i />{room ? statusText : "เล่นคนเดียว"}</span>
          <Dialog open={roomOpen} onOpenChange={setRoomOpen}>
            <DialogTrigger asChild><Button className="room-button"><Users /> {room || "เล่นกับเพื่อน"}</Button></DialogTrigger>
            <DialogContent className="room-dialog">
              <DialogHeader className="room-dialog-header"><span className="room-dialog-icon"><Users /></span><div><DialogTitle>เล่นด้วยกันแบบออนไลน์</DialogTitle><DialogDescription>ตั้งชื่อ แล้วสร้างห้องใหม่หรือใส่รหัสจากเพื่อน การเดินทุกช่องจะซิงก์แบบเรียลไทม์</DialogDescription></div></DialogHeader>
              <label className="field-label">ชื่อของคุณ<Input value={displayName} maxLength={24} onChange={(e) => setDisplayName(e.target.value)} placeholder="ชื่อผู้เล่น" /></label>
              <div className="room-choice">
                <Button onClick={createRoom} className="create-room"><Plus /> สร้างห้องจากเกมนี้</Button>
                <div className="or"><span>หรือ</span></div>
                <div className="join-row"><Input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8))} placeholder="รหัสห้อง 8 ตัว" className="code-input" /><Button onClick={joinRoom} disabled={joinCode.length !== 8}><LogIn /> เข้าห้อง</Button></div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <section className="workspace">
        <aside className="side-panel">
          <div><p className="eyebrow">ขนาดตาราง</p><div className="size-list">{PUZZLE_SIZES.map((value) => <button key={value} className={size === value ? "active" : ""} onClick={() => replacePuzzle(value)}><span>{value} × {value}</span><small>{value <= 5 ? "ง่าย" : value <= 10 ? "ปานกลาง" : value <= 15 ? "ท้าทาย" : "ผู้เชี่ยวชาญ"}</small></button>)}</div></div>
          <div className="rules"><p className="eyebrow">วิธีเล่น</p><p>เติมช่องให้ตรงกับตัวเลขด้านบนและด้านซ้าย ตัวเลขแต่ละชุดบอกจำนวนช่องทึบที่ติดกัน</p><p><b>คลิกซ้าย</b> เพื่อวนจาก เติม → × → ว่าง<br /><b>คลิกขวา</b> เพื่อสลับเครื่องหมาย ×<br /><b>หน้าจอสัมผัส</b> เปิดปุ่มดินสอเพื่อลากวาด ปิดเพื่อเลื่อนบอร์ด</p></div>
          <button className="new-puzzle-link" onClick={() => replacePuzzle(size)}><RotateCcw /> สุ่มโจทย์ใหม่</button>
        </aside>

        <section className="play-area">
          <div className="game-heading"><div><p className="eyebrow">PUZZLE #{seed}</p><h1>{size} × {size} Nonogram</h1></div><div className="game-meta"><TimeDisplay elapsed={elapsed} /></div></div>
          <div className="toolbar" role="toolbar" aria-label="คำแนะนำและประวัติการเล่น">
            <span className="cycle-hint"><i className="cycle-filled" /> เติม <b>→</b><X /> กากบาท <b>→</b><i className="cycle-empty" /> ว่าง</span><i className="toolbar-divider" />
            <button onClick={undo} disabled={!canUndo} aria-label="ย้อนกลับ"><Undo2 /></button><button onClick={redo} disabled={!canRedo} aria-label="ทำซ้ำ"><Redo2 /></button>
            <button className={`paint-toggle ${paintLock ? "is-on" : ""}`} onClick={togglePaintLock} aria-pressed={paintLock} aria-label={paintLock ? "ปิดโหมดวาด ให้เลื่อนหน้าจอได้" : "เปิดโหมดวาด สำหรับลากวาดบนหน้าจอสัมผัส"} title={paintLock ? "โหมดวาดเปิดอยู่ กดเพื่อให้เลื่อนบอร์ดได้" : "กดเพื่อล็อกหน้าจอไว้ลากวาด"}>{paintLock ? <Pencil /> : <Hand />}</button>
            <button onClick={toggleSound} aria-label={soundOn ? "ปิดเสียง" : "เปิดเสียง"} title={soundOn ? "ปิดเสียงเอฟเฟกต์" : "เปิดเสียงเอฟเฟกต์"}>{soundOn ? <Volume2 /> : <VolumeX />}</button>
          </div>
          <div className="board-scroll"><div className={`nonogram-board ${paintLock ? "paint-lock" : ""}`} style={boardStyle} onContextMenu={(event) => event.preventDefault()}>
            <div className="corner-cell"><span>ROWS</span><span>COLS</span></div>
            <div className="column-clues">{colClues.map((items, col) => <div key={col} className={`col-clue ${col > 0 && col % 5 === 0 ? "major-left" : ""}`}>
              {items.map((item, i) => { const key = `column-${col}-${i}`; return <ClueButton key={key} clueKey={key} label={`คอลัมน์ ${col + 1}`} item={item} completed={completedClues.has(key) || autoKeys.has(key)} onToggle={toggleClue} />; })}
            </div>)}</div>
            <div className="row-clues">{rowClues.map((items, row) => <div key={row} className={`row-clue ${row > 0 && row % 5 === 0 ? "major-top" : ""}`}>
              {items.map((item, i) => { const key = `row-${row}-${i}`; return <ClueButton key={key} clueKey={key} label={`แถว ${row + 1}`} item={item} completed={completedClues.has(key) || autoKeys.has(key)} onToggle={toggleClue} />; })}
            </div>)}</div>
            <div className="cells" style={{ gridTemplateColumns: `repeat(${size}, var(--cell))` }} onPointerLeave={() => { if (roomRef.current) roomClientRef.current?.sendCursor(null); }}>
              {cells.map((value, index) => {
                const row = Math.floor(index / size);
                const col = index % size;
                return <CellButton key={index} index={index} row={row} col={col} value={value} majorTop={row > 0 && row % 5 === 0} majorLeft={col > 0 && col % 5 === 0} peerCursor={peerCursors.get(index)} handlers={cellHandlers} />;
              })}
            </div>
          </div></div>
          {solved && <div className="success-card"><span><Check /></span><div><b>สำเร็จ!</b><p>{room ? "ทุกคนช่วยกันแก้ภาพนี้เรียบร้อยแล้ว" : "แก้ภาพนี้เรียบร้อยแล้ว"}{!room && bestSeconds !== null ? <> · เร็วที่สุด {formatSeconds(bestSeconds)}</> : null}</p></div><Button onClick={() => replacePuzzle(size)}>โจทย์ถัดไป</Button></div>}
        </section>

        <aside className="players-panel">
          <div className="players-title"><div><p className="eyebrow">ผู้เล่นในห้อง</p><h2>{room ? `${players.length || 1} คนออนไลน์` : "โหมดเดี่ยว"}</h2></div><span className="live-dot" /></div>
          {room ? <div className="player-list">{(players.length ? players : [me]).map((player) => <div className="player" key={player.id}><span className="avatar" style={{ background: player.color }}>{player.name.slice(0, 1).toUpperCase()}</span><div><b>{player.name}</b><small>{player.id === me.id ? "คุณ" : "กำลังเล่น"}</small></div></div>)}</div> : <div className="empty-players"><Users /><p>สร้างห้องเพื่อชวนเพื่อนมาเติมตารางพร้อมกัน เห็นเคอร์เซอร์ของกันและกันแบบเรียลไทม์</p></div>}
          {room && <><div className="room-code"><small>รหัสห้อง</small><b>{room}</b></div><Button variant="outline" className="share-button" onClick={shareRoom}><Copy /> คัดลอกลิงก์เชิญ</Button></>}
          <div className="collab-note"><Share2 /><p><b>เล่นพร้อมกันได้</b><br />การเดินแต่ละจังหวะซิงก์ทันที และเห็นตำแหน่งที่เพื่อนกำลังชี้อยู่</p></div>
        </aside>
      </section>
    </main>
  );
}
