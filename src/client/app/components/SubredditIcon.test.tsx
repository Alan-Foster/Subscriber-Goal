import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubredditIcon } from "./SubredditIcon";

describe("SubredditIcon", () => {
  it("renders subreddit icons at 80px by default with independent hover growth", () => {
    const html = renderToStaticMarkup(<SubredditIcon iconUrl="/icon.webp" />);

    expect(html).toContain('style="width:80px;height:80px"');
    expect(html).toContain('width="80"');
    expect(html).toContain('height="80"');
    expect(html).toContain("sg-hover-grow");
  });
});
