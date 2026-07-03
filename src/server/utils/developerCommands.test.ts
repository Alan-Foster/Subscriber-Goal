import { describe, expect, it } from "vitest";
import { parseDeveloperCommands } from "./developerCommands";

describe("parseDeveloperCommands", () => {
  it("parses runAs", () => {
    expect(parseDeveloperCommands("runAs")).toMatchObject({
      submitAsUser: true,
      selfPost: false,
      ignoredCommands: [],
      warnings: [],
    });
  });

  it("parses selfPost", () => {
    expect(parseDeveloperCommands("selfPost")).toMatchObject({
      selfPost: true,
      submitAsUser: false,
      ignoredCommands: [],
      warnings: [],
    });
  });

  it("parses selfPost and runAs together", () => {
    expect(parseDeveloperCommands("selfPost, runAs")).toMatchObject({
      selfPost: true,
      submitAsUser: true,
      ignoredCommands: [],
      warnings: [],
    });
  });

  it("parses a quoted header command", () => {
    expect(parseDeveloperCommands('header="Custom Message"')).toMatchObject({
      submitAsUser: false,
      selfPost: false,
      headerText: "Custom Message",
      ignoredCommands: [],
      warnings: [],
    });
  });

  it("parses runAs and header together", () => {
    expect(
      parseDeveloperCommands(
        'runAs, header="This post uses runAs and Custom Header"',
      ),
    ).toMatchObject({
      submitAsUser: true,
      headerText: "This post uses runAs and Custom Header",
    });
  });

  it("allows whitespace around command separators and equals", () => {
    expect(parseDeveloperCommands('  runAs  ,  header = "Spaced"  ')).toMatchObject(
      {
        submitAsUser: true,
        headerText: "Spaced",
      },
    );
  });

  it("allows commas inside quoted header text", () => {
    expect(parseDeveloperCommands('header="Hello, ExampleSub"')).toMatchObject({
      headerText: "Hello, ExampleSub",
    });
  });

  it("keeps wrong-case commands ignored", () => {
    expect(parseDeveloperCommands('RunAs, SelfPost, Header="Nope"')).toMatchObject({
      submitAsUser: false,
      selfPost: false,
      ignoredCommands: ["RunAs", "SelfPost", 'Header="Nope"'],
    });
  });

  it("ignores empty header values with a warning", () => {
    const result = parseDeveloperCommands('header="   "');

    expect(result.headerText).toBeUndefined();
    expect(result.warnings).toContain("Ignored empty header developer command.");
  });

  it("ignores malformed or unclosed quoted values", () => {
    const result = parseDeveloperCommands('header="Unclosed');

    expect(result.headerText).toBeUndefined();
    expect(result.ignoredCommands).toContain('header="Unclosed');
    expect(result.warnings).toContain(
      "Malformed developer command: unclosed quote.",
    );
  });

  it("truncates long header values", () => {
    const result = parseDeveloperCommands(`header="${"a".repeat(140)}"`);

    expect(result.headerText).toHaveLength(120);
    expect(result.warnings).toContain(
      "Truncated header developer command to 120 characters.",
    );
  });
});
