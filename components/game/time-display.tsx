"use client";

import { memo } from "react";
import { Clock3 } from "lucide-react";

export const TimeDisplay = memo(function TimeDisplay({ elapsed }: { elapsed: number }) {
  return (
    <span>
      <Clock3 /> {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}
    </span>
  );
});
