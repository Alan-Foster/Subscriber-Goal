import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GoalNotificationButton } from "./GoalNotificationButton";

describe("GoalNotificationButton", () => {
  it("uses the shared dynamically sized attention structure", () => {
    const html = renderToStaticMarkup(
      <GoalNotificationButton
        colorTheme="red"
        label="Notify me when the goal is reached"
        submitting={false}
        error={null}
        onOptIn={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(html).toContain("sg-attention-host");
    expect(html).toContain('class="sg-subscribe-attention-shell absolute"');
    expect(html).toContain('class="sg-subscribe-attention absolute"');
  });

  it("omits the attention treatment while submitting", () => {
    const html = renderToStaticMarkup(
      <GoalNotificationButton
        colorTheme="red"
        label="Notify me when the goal is reached"
        submitting
        error={null}
        onOptIn={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(html).not.toContain("sg-subscribe-attention-shell");
    expect(html).not.toContain("sg-subscribe-attention absolute");
  });
});
