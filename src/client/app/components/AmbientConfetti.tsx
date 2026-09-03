import { useMemo, type CSSProperties } from "react";

type AmbientConfettiProps = {
  reducedMotion?: boolean;
};

type AmbientConfettiStyle = CSSProperties & {
  "--ambient-confetti-drift"?: string;
};

const colors = [
  "#ff4500",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#a855f7",
  "#f472b6",
];

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
          color: colors[Math.floor(Math.random() * colors.length)],
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
      {pieces.map((piece, index) => {
        const style: AmbientConfettiStyle = {
          left: `${piece.left}%`,
          animationDelay: `${piece.delay}s`,
          animationDuration: `${piece.duration}s`,
          "--ambient-confetti-drift": `${piece.drift}px`,
        };
        return (
          <span key={index} className="ambient-confetti-piece" style={style}>
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
      })}
    </div>
  );
};
