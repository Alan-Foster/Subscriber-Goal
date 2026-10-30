// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markInitEnd,
  markInitStart,
  usePrimaryCtaPaintTiming,
} from "./startupPerformance";

const TimingProbe = ({ showCta }: { showCta: boolean }) => {
  usePrimaryCtaPaintTiming(true, String(showCta));
  return showCta ? <button data-subgoal-primary-cta="true">Join</button> : null;
};

describe("startupPerformance", () => {
  let container: HTMLDivElement;
  let root: Root;
  let entries: Set<string>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    entries = new Set();
    vi.stubGlobal("performance", {
      getEntriesByName: (name: string) => (entries.has(name) ? [{}] : []),
      mark: (name: string) => entries.add(name),
      measure: (name: string) => entries.add(name),
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("records init and primary CTA timing once the Join button commits", () => {
    performance.mark("subgoal:bootstrap");
    markInitStart();
    markInitEnd();

    act(() => root.render(<TimingProbe showCta />));

    expect(entries).toContain("subgoal:init:start");
    expect(entries).toContain("subgoal:init:end");
    expect(entries).toContain("subgoal:init:duration");
    expect(entries).toContain("subgoal:cta:commit");
    expect(entries).toContain("subgoal:cta:paint");
    expect(entries).toContain("subgoal:bootstrap-to-cta-paint");
    expect(entries).toContain("subgoal:init-response-to-cta-paint");
  });

  it("does not record CTA timing when no Join button is rendered", () => {
    performance.mark("subgoal:bootstrap");
    markInitStart();
    markInitEnd();

    act(() => root.render(<TimingProbe showCta={false} />));

    expect(entries).not.toContain("subgoal:cta:commit");
    expect(entries).not.toContain("subgoal:cta:paint");
  });
});
