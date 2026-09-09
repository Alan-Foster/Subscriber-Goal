// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNotificationSettings } from "./useNotificationSettings";

describe("useNotificationSettings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks a duplicate mutation before React rerenders", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let update:
      | ReturnType<typeof useNotificationSettings>["update"]
      | undefined;
    let resolveMutation: ((response: Response) => void) | undefined;
    const mutationResponse = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "notification-settings",
            authenticated: true,
            enabled: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockReturnValueOnce(mutationResponse);
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);

    const Harness = () => {
      const settings = useNotificationSettings(true);
      update = settings.update;
      return null;
    };
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    let first: ReturnType<NonNullable<typeof update>> | undefined;
    let second: ReturnType<NonNullable<typeof update>> | undefined;
    await act(async () => {
      first = update?.(true);
      second = update?.(true);
      await expect(second).resolves.toBeNull();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveMutation?.(
      new Response(
        JSON.stringify({
          type: "notification-settings",
          authenticated: true,
          enabled: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => {
      await first;
    });
    await act(async () => root.unmount());
  });
});
