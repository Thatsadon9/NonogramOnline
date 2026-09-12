import { nextPollInterval } from "./room-sync";

export type Player = { id: string; name: string; color: string; cursorIndex: number | null };
export type CellOp = { index: number; value: number; expect?: number };

export type RoomSnapshot = {
  code: string;
  size: number;
  seed: number;
  revision: number;
  completed: boolean;
  cells: number[];
  players: Player[] | null;
  elapsedSeconds: number;
  solution?: number[];
};

export type RoomPatch = {
  revision: number;
  completed: boolean;
  ops: Array<{ index: number; value: number }>;
  players: Player[] | null;
  elapsedSeconds: number;
};

export type RoomStatus = "connecting" | "live" | "offline";

export type RoomClientOptions = {
  code: string;
  identity: { id: string; name: string; color: string };
  onSnapshot: (snapshot: RoomSnapshot) => void;
  onPatch: (patch: RoomPatch) => void;
  onPlayers: (players: Player[]) => void;
  onStatus: (status: RoomStatus) => void;
};

const SILENCE_LIMIT_MS = 15_000;
const CURSOR_THROTTLE_MS = 250;
const HEARTBEAT_INTERVAL_MS = 8_000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

// Realtime room connection. Prefers an SSE push stream and falls back to
// adaptive delta polling when streaming is unavailable, so rooms keep working
// behind hostile proxies. Mutations are serialized through a promise chain to
// keep server-side optimistic concurrency retries effective.
export class RoomClient {
  private readonly options: RoomClientOptions;
  private connected = false;
  private stopped = false;
  private mode: "none" | "sse" | "poll" = "none";
  private eventSource: EventSource | null = null;
  private pollAbort: AbortController | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private knownRevision: number | null = null;
  private lastChangeAt = Date.now();
  private lastEventAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private cursorPending: number | null | undefined;
  private cursorLastSentAt = 0;
  private lastCursorSent: number | null | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RoomClientOptions) {
    this.options = options;
  }


  stop() {
    this.stopped = true;
    this.clearWatchdog();
    this.eventSource?.close();
    this.eventSource = null;
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }

  connect() {
    if (this.connected) return;
    this.connected = true;
    this.options.onStatus("connecting");
    if (typeof EventSource === "undefined") {
      this.startPolling();
      return;
    }
    this.mode = "sse";
    this.openStream();
  }

  private openStream() {
    if (this.stopped || this.mode !== "sse") return;
    const { code, identity } = this.options;
    const params = new URLSearchParams({
      code,
      playerId: identity.id,
      name: identity.name,
      color: identity.color,
    });
    const source = new EventSource(`/api/rooms/stream?${params}`);
    this.eventSource = source;
    this.lastEventAt = Date.now();
    this.armWatchdog();

    source.addEventListener("state", (event) => {
      this.markEvent();
      try {
        const snapshot = JSON.parse((event as MessageEvent).data) as RoomSnapshot;
        this.knownRevision = snapshot.revision;
        this.lastChangeAt = Date.now();
        this.options.onSnapshot(snapshot);
        if (snapshot.players) this.options.onPlayers(snapshot.players);
        this.options.onStatus("live");
      } catch {
        this.startPolling();
      }
    });

    source.addEventListener("patch", (event) => {
      this.markEvent();
      try {
        const patch = JSON.parse((event as MessageEvent).data) as RoomPatch;
        if (this.knownRevision === null || patch.revision > this.knownRevision) this.knownRevision = patch.revision;
        this.lastChangeAt = Date.now();
        this.options.onPatch(patch);
        if (patch.players) this.options.onPlayers(patch.players);
      } catch {
        // Ignore one malformed frame; the next tick resends full state.
      }
    });

    source.addEventListener("players", (event) => {
      this.markEvent();
      try {
        this.options.onPlayers(JSON.parse((event as MessageEvent).data) as Player[]);
      } catch {
        // Same as above.
      }
    });

    source.addEventListener("ping", () => {
      // Server heartbeat so an idle-but-healthy stream is not mistaken for
      // a dead one by the silence watchdog.
      this.markEvent();
    });

    source.addEventListener("gone", () => {
      this.markEvent();
      this.stop();
      this.options.onStatus("offline");
    });

    // "bye" means the server closed the stream on purpose; EventSource
    // reconnects on its own and receives a fresh full snapshot.

    source.onerror = () => {
      if (this.stopped) return;
      if (source.readyState === EventSource.CLOSED) this.startPolling();
      // CONNECTING means the browser is retrying; the silence watchdog
      // demotes us to polling if this drags on.
    };
  }

  private armWatchdog() {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      if (this.stopped || this.mode !== "sse") return;
      if (Date.now() - this.lastEventAt > SILENCE_LIMIT_MS) this.startPolling();
      else this.armWatchdog();
    }, SILENCE_LIMIT_MS + 500);
  }

  private clearWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private markEvent() {
    this.lastEventAt = Date.now();
    if (this.mode === "sse") this.armWatchdog();
  }

  private startPolling() {
    if (this.stopped || this.mode === "poll") return;
    this.clearWatchdog();
    this.eventSource?.close();
    this.eventSource = null;
    this.mode = "poll";
    this.options.onStatus("connecting");
    void this.pollLoop();
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  private async pollLoop() {
    this.pollAbort = new AbortController();
    const signal = this.pollAbort.signal;
    while (!this.stopped) {
      try {
        const params = new URLSearchParams({ code: this.options.code });
        if (this.knownRevision !== null) params.set("rev", String(this.knownRevision));
        const response = await fetch(`/api/rooms?${params}`, { cache: "no-store", signal });
        if (response.status === 204) {
          this.options.onStatus("live");
        } else if (response.ok) {
          const data = (await response.json()) as RoomSnapshot;
          if (this.knownRevision === null || data.revision > this.knownRevision) {
            this.knownRevision = data.revision;
            this.lastChangeAt = Date.now();
            this.options.onSnapshot(data);
          } else {
            // Presence and cursors can move without a revision bump.
            if (data.players) this.options.onPlayers(data.players);
            this.options.onStatus("live");
          }
        } else if (response.status === 404) {
          this.options.onStatus("offline");
        }
      } catch {
        if (!signal.aborted) this.options.onStatus("offline");
      }
      if (this.stopped) break;
      await sleep(nextPollInterval(Date.now() - this.lastChangeAt), signal);
    }
  }

  private async sendHeartbeat() {
    const { code, identity } = this.options;
    await this.post({ action: "heartbeat", code, playerId: identity.id, name: identity.name, color: identity.color }).catch(() => undefined);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.catch(() => undefined).then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private post(body: Record<string, unknown>) {
    return fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  sendCells(ops: CellOp[], seed: number): Promise<RoomSnapshot | null> {
    const { code } = this.options;
    return this.enqueue(async () => {
      const response = await this.post({ action: "cells", v: 2, code, seed, ops });
      if (!response.ok) throw new Error(`cell sync failed with ${response.status}`);
      const data = (await response.json()) as RoomSnapshot;
      this.knownRevision = data.revision;
      this.lastChangeAt = Date.now();
      return data;
    });
  }

  replace(size: number, seed: number, cells: number[]): Promise<RoomSnapshot | null> {
    const { code } = this.options;
    return this.enqueue(async () => {
      const response = await this.post({ action: "replace", v: 2, code, size, seed, cells });
      if (!response.ok) throw new Error(`replace failed with ${response.status}`);
      const data = (await response.json()) as RoomSnapshot;
      this.knownRevision = data.revision;
      this.lastChangeAt = Date.now();
      return data;
    });
  }

  sendCursor(index: number | null) {
    if (this.stopped || this.mode === "none") return;
    if (this.lastCursorSent === index && this.cursorPending === undefined) return;
    this.cursorPending = index;
    const wait = CURSOR_THROTTLE_MS - (Date.now() - this.cursorLastSentAt);
    if (wait <= 0) this.flushCursor();
    else if (this.cursorTimer === null) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.flushCursor();
      }, wait);
    }
  }

  private flushCursor() {
    if (this.cursorPending === undefined || this.stopped) return;
    const index = this.cursorPending;
    this.cursorPending = undefined;
    this.cursorLastSentAt = Date.now();
    this.lastCursorSent = index;
    const { code, identity } = this.options;
    void this.post({ action: "cursor", code, playerId: identity.id, cursor: index }).catch(() => undefined);
  }
}
