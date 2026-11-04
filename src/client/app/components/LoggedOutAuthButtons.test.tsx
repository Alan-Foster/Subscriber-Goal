import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LoggedOutAuthButtons } from "./LoggedOutAuthButtons";

describe("LoggedOutAuthButtons", () => {
  it("uses 18px labels while preserving auth button sizing and colors", () => {
    const html = renderToStaticMarkup(
      <LoggedOutAuthButtons
        signUpLabel="Sign Up"
        logInLabel="Log In"
        onAuthenticate={vi.fn()}
      />,
    );

    expect(html.match(/text-lg/g)).toHaveLength(2);
    expect(html).not.toContain("text-xl");
    expect(html.match(/min-h-\[60px\]/g)).toHaveLength(2);
    expect(html).toContain("bg-[#343a40]");
    expect(html).toContain("bg-[#ff4500]");
    expect(html.match(/sg-hover-grow/g)).toHaveLength(2);
  });
});
