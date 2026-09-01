// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  isWide: false,
  navigateTo: vi.fn(),
}));

vi.mock("@devvit/web/client", () => ({
  navigateTo: hoisted.navigateTo,
}));

vi.mock("../../hooks/useWideViewport", () => ({
  useWideViewport: () => hoisted.isWide,
}));

import { TinyPromoLink } from "./TinyPromoLink";

describe("TinyPromoLink", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetAllMocks();
    hoisted.isWide = false;
  });

  it("is absent from narrow Tiny views", () => {
    const html = renderToStaticMarkup(
      <TinyPromoLink promoSubreddit="SubGoal" language="en" />,
    );

    expect(html).toBe("");
  });

  it("reuses the localized promo button and navigates on wide views", async () => {
    hoisted.isWide = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TinyPromoLink promoSubreddit="SubGoal" language="es" />);
    });

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("r/SubGoal");
    expect(button?.getAttribute("aria-label")).toBe(
      "Ver otras metas de suscriptores en r/SubGoal",
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(button?.className).toContain("text-xs");
    expect(button?.className).toContain("group relative");
    const label = button?.querySelector("span");
    expect(label?.className).toContain("pointer-events-none");
    expect(label?.className).toContain("group-hover:pointer-events-auto");
    expect(label?.className).toContain("opacity-0");
    expect(label?.className).toContain("duration-[250ms]");
    expect(label?.className).toContain("group-hover:opacity-100");
    expect(label?.className).toContain("group-focus-visible:opacity-100");
    expect(label?.className).toContain("motion-reduce:transition-none");
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("20");
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("20");
    expect(container.innerHTML).toContain("absolute right-4 top-4 z-20");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hoisted.navigateTo).toHaveBeenCalledWith(
      "https://www.reddit.com/r/SubGoal/",
    );

    await act(async () => root.unmount());
    container.remove();
  });
});
