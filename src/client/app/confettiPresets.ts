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
  completed: {
    durationMs: 2800,
    allowRestart: true,
  },
  logoCelebrate: {
    pieceCount: 48,
    durationMs: 3600,
    allowRestart: false,
  },
} as const;
