"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock3, Copy, Grid3X3, LogIn, Plus, Redo2, RotateCcw, Share2, Undo2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { generateSolution, pickPuzzleSeed, PUZZLE_SEEDS, PUZZLE_SIZES, type PuzzleSize } from "@/lib/puzzle-generator";
import { acceptsRevision, enqueueByKey, mergePendingCells, type PendingCell } from "@/lib/room-sync";

type Cell = 0 | 1 | 2;
type Player = { id: string; name: string; color: string };
type RoomState = { code: string; size: PuzzleSize; seed: number; solution: number[]; cells: Cell[]; revision: number; completed: boolean; players?: Player[] };
type ErrorResponse = { error?: string };
type ClueProgress = { puzzleKey: string; completed: Set<string> };

const COLORS = ["#3457D5", "#E4572E", "#138A72", "#8A4FFF", "#DB8B00"];
const INITIAL_SEED = PUZZLE_SEEDS[10][9];
const EMPTY_COMPLETED_CLUES = new Set<string>();

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function clues(line: number[]) {
  const result: number[] = [];
  let run = 0;
  for (const value of [...line, 0]) {
    if (value) run++;
    else if (run) { result.push(run); run = 0; }
  }
  return result.length ? result : [0];
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

function playerIdentity(): Player {
  if (typeof window === "undefined") return { id: "", name: "ผู้เล่น", color: COLORS[0] };
  let id = localStorage.getItem("nonogram-player-id");
  if (!id) { id = crypto.randomUUID(); localStorage.setItem("nonogram-player-id", id); }
  return { id, name: localStorage.getItem("nonogram-player-name") || `ผู้เล่น ${id.slice(0, 3)}`, color: COLORS[Number.parseInt(id.slice(-2), 16) % COLORS.length] || COLORS[0] };
}

function isSolved(cells: Cell[], solution: number[]) {
  return solution.every((answer, index) => answer === 1 ? cells[index] === 1 : cells[index] !== 1);
}

export default function Home() {
  const [size, setSize] = useState<PuzzleSize>(10);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [solution, setSolution] = useState<number[]>(() => generateSolution(10, INITIAL_SEED));
  const [cells, setCells] = useState<Cell[]>(() => Array(100).fill(0));
  const [historyStack, setHistoryStack] = useState<Cell[][]>([]);
  const [future, setFuture] = useState<Cell[][]>([]);
  const [room, setRoom] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roomOpen, setRoomOpen] = useState(false);
  const [status, setStatus] = useState("พร้อมเล่น");
  const [elapsed, setElapsed] = useState(0);
  const [started, setStarted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragValue, setDragValue] = useState<Cell>(1);
  const [clueProgress, setClueProgress] = useState<ClueProgress>(() => ({
    puzzleKey: `10:${INITIAL_SEED}`,
    completed: new Set(),
  }));
  const identity = useRef<Player>({ id: "", name: "ผู้เล่น", color: COLORS[0] });
  const roomRef = useRef("");
  const seedRef = useRef(seed);
  const solutionRef = useRef(solution);
  const cellsRef = useRef(cells);
  const serverCellsRef = useRef(cells);
  const revisionRef = useRef(0);
  const mutationIdRef = useRef(0);
  const pendingCellsRef = useRef(new Map<number, PendingCell<Cell>>());
  const cellQueuesRef = useRef(new Map<number, Promise<void>>());
  const [me, setMe] = useState<Player>({ id: "", name: "ผู้เล่น", color: COLORS[0] });
  const solved = useMemo(() => isSolved(cells, solution), [cells, solution]);

  useEffect(() => {
    identity.current = playerIdentity();
    setMe(identity.current);
    setDisplayName(identity.current.name);
    const urlRoom = new URLSearchParams(location.search).get("room");
    if (urlRoom) { setJoinCode(urlRoom.toUpperCase()); setRoomOpen(true); }
  }, []);

  useEffect(() => {
    if (!started || solved) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [started, solved]);

  const rowClues = useMemo(() => Array.from({ length: size }, (_, row) => clues(solution.slice(row * size, (row + 1) * size))), [size, solution]);
  const colClues = useMemo(() => Array.from({ length: size }, (_, col) => clues(Array.from({ length: size }, (_, row) => solution[row * size + col]))), [size, solution]);
  const puzzleKey = `${size}:${seed}`;
  const completedClues = clueProgress.puzzleKey === puzzleKey ? clueProgress.completed : EMPTY_COMPLETED_CLUES;
  const renderServerWithPending = useCallback(() => {
    const merged = mergePendingCells(serverCellsRef.current, pendingCellsRef.current);
    cellsRef.current = merged;
    setCells(merged);
  }, []);

  const applyRoom = useCallback((data: RoomState, force = false) => {
    if (data.players) setPlayers(data.players);
    if (data.code !== roomRef.current || (!force && !acceptsRevision(revisionRef.current, data.revision))) return false;

    revisionRef.current = data.revision;
    seedRef.current = data.seed;
    solutionRef.current = data.solution;
    serverCellsRef.current = data.cells;
    setSize(data.size);
    setSeed(data.seed);
    setSolution(data.solution);
    renderServerWithPending();
    if (data.cells.some(Boolean) || pendingCellsRef.current.size) setStarted(true);
    return true;
  }, [renderServerWithPending]);

  useEffect(() => {
    if (!room) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/rooms?code=${room}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await readJson<RoomState>(response);
        if (active) applyRoom(data);
      } catch { /* local board stays available during reconnect */ }
      finally { if (active) timeout = setTimeout(poll, 700); }
    };
    void poll();
    return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [room, applyRoom]);

  useEffect(() => {
    if (!room || !identity.current.id) return;
    const beat = () => fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat", code: room, playerId: identity.current.id, name: identity.current.name, color: identity.current.color }) }).catch(() => undefined);
    void beat();
    const interval = setInterval(beat, 8000);
    return () => clearInterval(interval);
  }, [room]);

  const saveCell = (index: number, value: Cell, puzzleSeed: number) => {
    const roomCode = roomRef.current;
    if (!roomCode) return;

    const operationId = ++mutationIdRef.current;
    pendingCellsRef.current.set(index, { id: operationId, value });
    setStatus("กำลังซิงก์…");

    void enqueueByKey(cellQueuesRef.current, index, async () => {
      try {
        const response = await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cell", code: roomCode, seed: puzzleSeed, index, value }),
        });
        const data = response.ok ? await readJson<RoomState>(response) : undefined;
        if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;

        if (pendingCellsRef.current.get(index)?.id === operationId) pendingCellsRef.current.delete(index);
        if (!data || !applyRoom(data)) renderServerWithPending();
        setStatus(!response.ok ? "รอเชื่อมต่อ…" : pendingCellsRef.current.size ? "กำลังซิงก์…" : "ซิงก์แล้ว");
      } catch {
        if (roomRef.current !== roomCode || seedRef.current !== puzzleSeed) return;
        if (pendingCellsRef.current.get(index)?.id === operationId) pendingCellsRef.current.delete(index);
        renderServerWithPending();
        setStatus("รอเชื่อมต่อ…");
      }
    });
  };

  const paint = (index: number, value?: Cell, remember = true) => {
    const current = cellsRef.current;
    if (isSolved(current, solutionRef.current) || index < 0 || index >= current.length) return;
    const nextValue = value ?? ((current[index] + 1) % 3 as Cell);
    if (current[index] === nextValue) return;
    const next = [...current]; next[index] = nextValue;
    if (remember && !roomRef.current) { setHistoryStack((items) => [...items.slice(-39), current]); setFuture([]); }
    cellsRef.current = next;
    setCells(next);
    setStarted(true);
    saveCell(index, nextValue, seedRef.current);
  };

  const startDrag = (index: number, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const value = ((cellsRef.current[index] + 1) % 3) as Cell;
    setDragging(true); setDragValue(value); paint(index, value, true);
  };

  const replacePuzzle = async (nextSize: PuzzleSize) => {
    const randomValue = crypto.getRandomValues(new Uint32Array(1))[0];
    const nextSeed = pickPuzzleSeed(nextSize, randomValue, nextSize === size ? seed : undefined);
    const nextSolution = generateSolution(nextSize, nextSeed);
    const nextCells: Cell[] = Array(nextSize * nextSize).fill(0);
    const roomCode = roomRef.current;

    if (roomCode) {
      setStatus("กำลังเปลี่ยนโจทย์…");
      try {
        const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "replace", code: roomCode, size: nextSize, seed: nextSeed, solution: nextSolution, cells: nextCells }) });
        if (!response.ok) { setStatus("เปลี่ยนโจทย์ไม่สำเร็จ"); return; }
        pendingCellsRef.current.clear();
        const data = await readJson<RoomState>(response);
        applyRoom(data, true);
        setHistoryStack([]); setFuture([]); setElapsed(0); setStarted(false); setStatus("ซิงก์แล้ว");
      } catch { setStatus("รอเชื่อมต่อ…"); }
      return;
    }

    seedRef.current = nextSeed;
    solutionRef.current = nextSolution;
    cellsRef.current = nextCells;
    serverCellsRef.current = nextCells;
    setSize(nextSize); setSeed(nextSeed); setSolution(nextSolution); setCells(nextCells);
    setHistoryStack([]); setFuture([]); setElapsed(0); setStarted(false);
  };

  const createRoom = async () => {
    setStatus("กำลังสร้างห้อง…");
    const roomCode = makeCode();
    const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", code: roomCode, size, seed, solution, cells }) });
    if (!response.ok) { const data = await readJson<ErrorResponse>(response); setStatus(data.error || "สร้างห้องไม่สำเร็จ"); return; }
    identity.current.name = displayName.trim() || identity.current.name;
    setMe({ ...identity.current });
    localStorage.setItem("nonogram-player-name", identity.current.name);
    roomRef.current = roomCode;
    revisionRef.current = 0;
    serverCellsRef.current = cellsRef.current;
    pendingCellsRef.current.clear();
    setHistoryStack([]); setFuture([]);
    setRoom(roomCode); setRoomOpen(false); setStatus("ห้องออนไลน์แล้ว");
    window.history.replaceState(null, "", `?room=${roomCode}`);
  };

  const joinRoom = async () => {
    const target = joinCode.trim().toUpperCase(); setStatus("กำลังเข้าห้อง…");
    const response = await fetch(`/api/rooms?code=${target}`, { cache: "no-store" });
    if (!response.ok) { const data = await readJson<ErrorResponse>(response); setStatus(data.error || "เข้าห้องไม่สำเร็จ"); return; }
    const data = await readJson<RoomState>(response);
    identity.current.name = displayName.trim() || identity.current.name;
    setMe({ ...identity.current });
    localStorage.setItem("nonogram-player-name", identity.current.name);
    roomRef.current = target;
    revisionRef.current = data.revision;
    pendingCellsRef.current.clear();
    setHistoryStack([]); setFuture([]); setElapsed(0);
    applyRoom(data, true); setRoom(target); setRoomOpen(false); setStatus("เข้าห้องแล้ว");
    window.history.replaceState(null, "", `?room=${target}`);
  };

  const shareRoom = async () => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${room}`);
    setStatus("คัดลอกลิงก์ห้องแล้ว");
  };

  const undo = () => {
    if (roomRef.current) return;
    const previous = historyStack.at(-1); if (!previous) return;
    const current = cellsRef.current;
    setFuture((items) => [current, ...items]); cellsRef.current = previous; setCells(previous); setHistoryStack((items) => items.slice(0, -1));
  };
  const redo = () => {
    if (roomRef.current) return;
    const next = future[0]; if (!next) return;
    setHistoryStack((items) => [...items, cellsRef.current]); cellsRef.current = next; setCells(next); setFuture((items) => items.slice(1));
  };

  const toggleClue = (key: string) => {
    setClueProgress((current) => {
      const next = new Set(current.puzzleKey === puzzleKey ? current.completed : undefined);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { puzzleKey, completed: next };
    });
  };

  const cellSize = size <= 5 ? 52 : size <= 10 ? 38 : size <= 15 ? 29 : size <= 20 ? 24 : 21;
  const boardStyle = { "--cell": `${cellSize}px`, "--rows": size, "--cols": size, "--row-clues": Math.max(...rowClues.map((item) => item.length)), "--col-clues": Math.max(...colClues.map((item) => item.length)) } as React.CSSProperties;

  return (
    <main className="game-shell" onPointerUp={() => setDragging(false)} onPointerLeave={() => setDragging(false)}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Nonogram Together หน้าแรก"><span className="brand-mark"><Grid3X3 /></span><span>NONOGRAM <b>TOGETHER</b></span></a>
        <div className="top-actions">
          <span className={`sync-state ${room ? "online" : ""}`}><i />{room ? status : "เล่นคนเดียว"}</span>
          <Dialog open={roomOpen} onOpenChange={setRoomOpen}>
            <DialogTrigger asChild><Button className="room-button"><Users /> {room || "เล่นกับเพื่อน"}</Button></DialogTrigger>
            <DialogContent className="room-dialog">
              <DialogHeader className="room-dialog-header"><span className="room-dialog-icon"><Users /></span><div><DialogTitle>เล่นด้วยกันแบบออนไลน์</DialogTitle><DialogDescription>ตั้งชื่อ แล้วสร้างห้องใหม่หรือใส่รหัสจากเพื่อน ทุกช่องจะซิงก์ผ่าน Neon</DialogDescription></div></DialogHeader>
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
          <div className="rules"><p className="eyebrow">วิธีเล่น</p><p>เติมช่องให้ตรงกับตัวเลขด้านบนและด้านซ้าย ตัวเลขแต่ละชุดบอกจำนวนช่องทึบที่ติดกัน</p><p><b>คลิกซ้าย</b> เพื่อวนจาก เติม → × → ว่าง<br /><b>คลิกขวา</b> เพื่อสลับเครื่องหมาย ×</p></div>
          <button className="new-puzzle-link" onClick={() => replacePuzzle(size)}><RotateCcw /> สุ่มโจทย์ใหม่</button>
        </aside>

        <section className="play-area">
          <div className="game-heading"><div><p className="eyebrow">PUZZLE #{seed}</p><h1>{size} × {size} Nonogram</h1></div><div className="game-meta"><span><Clock3 /> {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span></div></div>
          <div className="toolbar" role="toolbar" aria-label="คำแนะนำและประวัติการเล่น">
            <span className="cycle-hint"><i className="cycle-filled" /> เติม <b>→</b><X /> กากบาท <b>→</b><i className="cycle-empty" /> ว่าง</span><i className="toolbar-divider" />
            <button onClick={undo} disabled={Boolean(room) || !historyStack.length} aria-label={room ? "ย้อนกลับใช้ได้เฉพาะโหมดเดี่ยว" : "ย้อนกลับ"}><Undo2 /></button><button onClick={redo} disabled={Boolean(room) || !future.length} aria-label={room ? "ทำซ้ำใช้ได้เฉพาะโหมดเดี่ยว" : "ทำซ้ำ"}><Redo2 /></button>
          </div>
          <div className="board-scroll"><div className="nonogram-board" style={boardStyle} onContextMenu={(event) => event.preventDefault()}>
            <div className="corner-cell"><span>ROWS</span><span>COLS</span></div>
            <div className="column-clues">{colClues.map((items, col) => <div key={col} className={`col-clue ${col > 0 && col % 5 === 0 ? "major-left" : ""}`}>
              {items.map((item, i) => {
                const key = `column-${col}-${i}`;
                const completed = completedClues.has(key);
                return <button type="button" key={key} className={`clue-number ${completed ? "is-complete" : ""}`} aria-label={`คอลัมน์ ${col + 1} เลข ${item}${completed ? " ทำครบแล้ว" : ""}`} aria-pressed={completed} title={completed ? "กดเพื่อยกเลิกเครื่องหมาย" : "กดเพื่อทำเครื่องหมายว่าครบแล้ว"} onClick={() => toggleClue(key)}>{item}</button>;
              })}
            </div>)}</div>
            <div className="row-clues">{rowClues.map((items, row) => <div key={row} className={`row-clue ${row > 0 && row % 5 === 0 ? "major-top" : ""}`}>
              {items.map((item, i) => {
                const key = `row-${row}-${i}`;
                const completed = completedClues.has(key);
                return <button type="button" key={key} className={`clue-number ${completed ? "is-complete" : ""}`} aria-label={`แถว ${row + 1} เลข ${item}${completed ? " ทำครบแล้ว" : ""}`} aria-pressed={completed} title={completed ? "กดเพื่อยกเลิกเครื่องหมาย" : "กดเพื่อทำเครื่องหมายว่าครบแล้ว"} onClick={() => toggleClue(key)}>{item}</button>;
              })}
            </div>)}</div>
            <div className="cells" style={{ gridTemplateColumns: `repeat(${size}, var(--cell))` }}>{cells.map((value, index) => { const row = Math.floor(index / size); const col = index % size; const stateLabel = value === 1 ? "เติมแล้ว" : value === 2 ? "กากบาท" : "ว่าง"; return <button key={index} aria-label={`แถว ${row + 1} คอลัมน์ ${col + 1} ${stateLabel}`} className={`cell state-${value} ${row > 0 && row % 5 === 0 ? "major-top" : ""} ${col > 0 && col % 5 === 0 ? "major-left" : ""}`} onPointerDown={(event) => startDrag(index, event)} onPointerEnter={() => dragging && paint(index, dragValue, false)} onContextMenu={(event) => { event.preventDefault(); paint(index, cellsRef.current[index] === 2 ? 0 : 2); }}>{value === 2 && <X />}</button>; })}</div>
          </div></div>
          {solved && <div className="success-card"><span><Check /></span><div><b>สำเร็จ!</b><p>ทุกคนช่วยกันแก้ภาพนี้เรียบร้อยแล้ว</p></div><Button onClick={() => replacePuzzle(size)}>โจทย์ถัดไป</Button></div>}
        </section>

        <aside className="players-panel">
          <div className="players-title"><div><p className="eyebrow">ผู้เล่นในห้อง</p><h2>{room ? `${players.length || 1} คนออนไลน์` : "โหมดเดี่ยว"}</h2></div><span className="live-dot" /></div>
          {room ? <div className="player-list">{(players.length ? players : [me]).map((player) => <div className="player" key={player.id}><span className="avatar" style={{ background: player.color }}>{player.name.slice(0, 1).toUpperCase()}</span><div><b>{player.name}</b><small>{player.id === me.id ? "คุณ" : "กำลังเล่น"}</small></div></div>)}</div> : <div className="empty-players"><Users /><p>สร้างห้องเพื่อชวนเพื่อนมาเติมตารางพร้อมกัน</p></div>}
          {room && <><div className="room-code"><small>รหัสห้อง</small><b>{room}</b></div><Button variant="outline" className="share-button" onClick={shareRoom}><Copy /> คัดลอกลิงก์เชิญ</Button></>}
          <div className="collab-note"><Share2 /><p><b>เล่นพร้อมกันได้</b><br />ทุกการเปลี่ยนแปลงบันทึกลง Neon และส่งถึงเพื่อนแบบต่อเนื่อง</p></div>
        </aside>
      </section>
    </main>
  );
}
