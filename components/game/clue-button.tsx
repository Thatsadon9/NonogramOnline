"use client";

import { memo } from "react";

type ClueButtonProps = {
  clueKey: string;
  label: string;
  item: number;
  completed: boolean;
  onToggle: (key: string) => void;
};

export const ClueButton = memo(function ClueButton({ clueKey, label, item, completed, onToggle }: ClueButtonProps) {
  return (
    <button
      type="button"
      className={`clue-number ${completed ? "is-complete" : ""}`}
      aria-label={`${label} เลข ${item}${completed ? " ทำครบแล้ว" : ""}`}
      aria-pressed={completed}
      title={completed ? "กดเพื่อยกเลิกเครื่องหมาย" : "กดเพื่อทำเครื่องหมายว่าครบแล้ว"}
      onClick={() => onToggle(clueKey)}
    >
      {item}
    </button>
  );
});
