const headerMaxLength = 120;

export type DeveloperCommandResult = {
  submitAsUser: boolean;
  headerText?: string;
  ignoredCommands: string[];
  warnings: string[];
};

const emptyResult = (): DeveloperCommandResult => ({
  submitAsUser: false,
  ignoredCommands: [],
  warnings: [],
});

const splitCommands = (value: string): { commands: string[]; quoteOpen: boolean } => {
  const commands: string[] = [];
  let current = "";
  let inQuote = false;

  for (const char of value) {
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (char === "," && !inQuote) {
      commands.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  commands.push(current);
  return { commands, quoteOpen: inQuote };
};

const normalizeHeaderText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const parseDeveloperCommands = (
  rawValue: string | undefined,
): DeveloperCommandResult => {
  const value = rawValue?.trim();
  if (!value) {
    return emptyResult();
  }

  const result = emptyResult();
  const { commands, quoteOpen } = splitCommands(value);
  if (quoteOpen) {
    result.warnings.push("Malformed developer command: unclosed quote.");
  }

  for (const rawCommand of commands) {
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    if (command === "runAs") {
      result.submitAsUser = true;
      continue;
    }

    const headerMatch = /^header\s*=\s*"([^"]*)"$/.exec(command);
    if (headerMatch) {
      const normalizedHeader = normalizeHeaderText(headerMatch[1] ?? "");
      if (!normalizedHeader) {
        result.warnings.push("Ignored empty header developer command.");
        continue;
      }
      if (normalizedHeader.length > headerMaxLength) {
        result.headerText = normalizedHeader.slice(0, headerMaxLength);
        result.warnings.push(
          `Truncated header developer command to ${headerMaxLength} characters.`,
        );
        continue;
      }
      result.headerText = normalizedHeader;
      continue;
    }

    if (command.startsWith("header")) {
      result.warnings.push(`Ignored malformed header developer command: ${command}`);
      result.ignoredCommands.push(command);
      continue;
    }

    result.ignoredCommands.push(command);
  }

  return result;
};
