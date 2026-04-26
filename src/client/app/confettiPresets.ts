export const confettiPresets = {
  default: {
    pieceCount: 70,
    durationMs: 2600,
  },
  subscribe: {
    durationMs: 2800,
  },
  completed: {
    durationMs: 2800,
    allowRestart: false,
  },
  logoCelebrate: {
    pieceCount: 48,
    durationMs: 3600,
    allowRestart: false,
  },
} as const;
