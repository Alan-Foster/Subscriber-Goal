export const confettiColors = [
  "#ff4500",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#a855f7",
  "#f472b6",
];

export const confettiPresets = {
  default: {
    pieceCount: 70,
    durationMs: 2600,
  },
  click: {
    pieceCount: 28,
    durationMs: 1600,
  },
  subscribe: {
    durationMs: 2800,
  },
  logoCelebrate: {
    pieceCount: 48,
    durationMs: 3600,
    allowRestart: false,
  },
} as const;
