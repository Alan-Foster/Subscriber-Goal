import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubredditIcon } from "./SubredditIcon";

describe("SubredditIcon", () => {
  it("renders subreddit icons at 60px by default with independent hover growth", () => {
    const html = renderToStaticMarkup(<SubredditIcon iconUrl="/icon.webp" />);

    expect(html).toContain('style="width:60px;height:60px"');
    expect(html).toContain('width="60"');
    expect(html).toContain('height="60"');
    expect(html).toContain("sg-hover-grow");
  });
});
