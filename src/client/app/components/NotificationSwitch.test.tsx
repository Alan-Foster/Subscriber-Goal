// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSwitch } from "./NotificationSwitch";

describe("NotificationSwitch", () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("exposes a checked switch and reports the requested state", async () => {
    const onCheckedChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <NotificationSwitch
          checked
          disabled={false}
          label="Goal completion alerts: Enabled"
          onCheckedChange={onCheckedChange}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    );
    expect(input?.checked).toBe(true);
    expect(input?.getAttribute("aria-label")).toBe(
      "Goal completion alerts: Enabled",
    );
    await act(async () => input?.click());
    expect(onCheckedChange).toHaveBeenCalledWith(false);

    await act(async () => root.unmount());
  });

  it("blocks changes while disabled", async () => {
    const onCheckedChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <NotificationSwitch
          checked={false}
          disabled
          label="Goal completion alerts: Disabled"
          onCheckedChange={onCheckedChange}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[role="switch"]',
    );
    expect(input?.disabled).toBe(true);
    await act(async () => input?.click());
    expect(onCheckedChange).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });
});
