import { useMemo } from "react";
import { confettiColors } from "../confettiPresets";
import { ConfettiPiece } from "./ConfettiPiece";

type ConfettiBurstProps = {
  pieceCount?: number;
  reducedMotion?: boolean;
};

export const ConfettiBurst = ({
  pieceCount = 70,
  reducedMotion = false,
}: ConfettiBurstProps) => {
  const pieces = useMemo(
    () =>
      Array.from({ length: pieceCount }, () => ({
        left: Math.random() * 100,
        drift: (Math.random() * 2 - 1) * 80,
        delay: Math.random() * 0.35,
        duration: 1.6 + Math.random() * 1.4,
        size: 6 + Math.random() * 6,
        rotate: Math.random() * 360,
        color:
          confettiColors[Math.floor(Math.random() * confettiColors.length)],
      })),
    [pieceCount],
  );

  if (reducedMotion) {
    return (
      <div
        aria-hidden="true"
        className="celebration-flash"
        data-celebration-effect="flash"
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      className="confetti"
      data-celebration-effect="confetti"
      data-confetti-piece-count={pieceCount}
    >
      {pieces.map((piece, index) => (
        <ConfettiPiece key={index} piece={piece} variant="confetti" />
      ))}
    </div>
  );
};
