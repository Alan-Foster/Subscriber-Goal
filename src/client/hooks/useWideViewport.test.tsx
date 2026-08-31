// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWideViewport, wideViewportMediaQuery } from "./useWideViewport";

const Harness = () => <div>{useWideViewport() ? "wide" : "narrow"}</div>;

describe("useWideViewport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("treats an environment without matchMedia as narrow", async () => {
    Reflect.deleteProperty(window, "matchMedia");

    await act(async () => root.render(<Harness />));

    expect(container.textContent).toBe("narrow");
  });

  it("detects the 640px breakpoint and responds to viewport changes", async () => {
    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mediaQuery = {
      get matches() {
        return matches;
      },
      media: wideViewportMediaQuery,
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: EventListener) => {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    window.matchMedia = vi.fn().mockReturnValue(mediaQuery);

    await act(async () => root.render(<Harness />));
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 640px)");
    expect(container.textContent).toBe("narrow");

    matches = true;
    await act(async () => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(container.textContent).toBe("wide");
  });
});
