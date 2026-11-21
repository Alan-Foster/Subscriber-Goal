import { useMemo } from "react";
import { confettiColors } from "../confettiPresets";
import { ConfettiPiece } from "./ConfettiPiece";

type AmbientConfettiProps = {
  reducedMotion?: boolean;
};

export const ambientConfettiPieceCount = 30;

export const AmbientConfetti = ({
  reducedMotion = false,
}: AmbientConfettiProps) => {
  const pieces = useMemo(
    () =>
      Array.from({ length: ambientConfettiPieceCount }, (_, index) => {
        const duration = 6 + Math.random() * 3;
        const phase = (index + 0.5) / ambientConfettiPieceCount;
        return {
          left: Math.random() * 100,
          drift: (Math.random() * 2 - 1) * 80,
          delay: -phase * duration,
          duration,
          size: 6 + Math.random() * 6,
          rotate: Math.random() * 360,
          color:
            confettiColors[Math.floor(Math.random() * confettiColors.length)],
        };
      }),
    [],
  );

  if (reducedMotion) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      className="ambient-confetti"
      data-celebration-effect="ambient-confetti"
      data-confetti-piece-count={ambientConfettiPieceCount}
    >
      {pieces.map((piece, index) => (
        <ConfettiPiece key={index} piece={piece} variant="ambient-confetti" />
      ))}
    </div>
  );
};
