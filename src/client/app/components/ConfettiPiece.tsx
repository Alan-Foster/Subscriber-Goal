import type { CSSProperties } from "react";

type ConfettiPieceProps = {
  piece: {
    left: number;
    delay: number;
    duration: number;
    drift: number;
    size: number;
    color: CSSProperties["backgroundColor"];
    rotate: number;
  };
  variant: "confetti" | "ambient-confetti";
};

export function ConfettiPiece({ piece, variant }: ConfettiPieceProps) {
  const style: CSSProperties &
    Partial<Record<`--${typeof variant}-drift`, string>> = {
    left: `${piece.left}%`,
    animationDelay: `${piece.delay}s`,
    animationDuration: `${piece.duration}s`,
    [`--${variant}-drift`]: `${piece.drift}px`,
  };
  return (
    <span className={`${variant}-piece`} style={style}>
      <span
        className="block rounded-sm"
        style={{
          width: piece.size,
          height: piece.size * 1.4,
          backgroundColor: piece.color,
          transform: `rotate(${piece.rotate}deg)`,
        }}
      />
    </span>
  );
}
