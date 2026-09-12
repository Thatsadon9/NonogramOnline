"use client";

import { memo } from "react";
import { X } from "lucide-react";
import type { CellValue } from "@/lib/nonogram";

export type CellHandlers = {
  onPaintDown: (index: number, event: React.PointerEvent<HTMLButtonElement>) => void;
  onPaintEnter: (index: number, event: React.PointerEvent<HTMLButtonElement>) => void;
  onPaintMenu: (index: number, event: React.MouseEvent<HTMLButtonElement>) => void;
};

type CellButtonProps = {
  index: number;
  row: number;
  col: number;
  value: CellValue;
  majorTop: boolean;
  majorLeft: boolean;
  peerCursor: string | undefined;
  handlers: CellHandlers;
};

// Memoized so a single changed cell (or a ticking timer) touches one DOM
// node instead of reconciling the whole 625-button board.
export const CellButton = memo(function CellButton({ index, row, col, value, majorTop, majorLeft, peerCursor, handlers }: CellButtonProps) {
  const stateLabel = value === 1 ? "เติมแล้ว" : value === 2 ? "กากบาท" : "ว่าง";
  const classes = ["cell", `state-${value}`];
  if (majorTop) classes.push("major-top");
  if (majorLeft) classes.push("major-left");
  if (peerCursor) classes.push("peer-cursor");
  return (
    <button
      aria-label={`แถว ${row + 1} คอลัมน์ ${col + 1} ${stateLabel}`}
      className={classes.join(" ")}
      style={peerCursor ? ({ "--peer-cursor": peerCursor } as React.CSSProperties) : undefined}
      onPointerDown={(event) => handlers.onPaintDown(index, event)}
      onPointerEnter={(event) => handlers.onPaintEnter(index, event)}
      onContextMenu={(event) => handlers.onPaintMenu(index, event)}
    >
      {value === 2 ? <X /> : null}
    </button>
  );
});
