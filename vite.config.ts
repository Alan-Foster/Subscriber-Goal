import { defineConfig } from "vitest/config";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { devvit } from "@devvit/start/vite";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwind(), ...(command === "build" ? [devvit()] : [])],
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.stryker-tmp/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "src/server/testing/**", "**/*.d.ts"],
      reporter: ["text-summary", "html", "json", "json-summary"],
      thresholds: { statements: 89, branches: 84, functions: 95, lines: 90 },
    },
  },
}));
