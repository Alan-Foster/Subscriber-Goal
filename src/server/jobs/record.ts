type Field<T> = {
  parse(raw: string): T | undefined;
  serialize(value: T): string;
};

export const textField: Field<string> = {
  parse: (raw) => raw,
  serialize: (value) => value,
};

export const timeField: Field<number | null> = {
  parse: (raw) => {
    if (raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  },
  serialize: (value) => (value === null ? "" : String(value)),
};

export const flagField: Field<boolean> = {
  parse: (raw) => (raw === "true" ? true : raw === "false" ? false : undefined),
  serialize: String,
};

type Status = "pending" | "processing" | "complete" | "exhausted";
const statusField: Field<Status> = {
  parse: (raw) => {
    switch (raw) {
      case "pending":
      case "processing":
      case "complete":
      case "exhausted":
        return raw;
      default:
        return undefined;
    }
  },
  serialize: String,
};

const attemptsField: Field<number> = {
  parse: (raw) => Math.max(0, parseInt(raw, 10) || 0),
  serialize: String,
};

export type JobCodec<T extends object> = {
  parse(raw: Record<string, string>): Partial<T>;
  serialize(record: Partial<T>): Record<string, string>;
};

export function createJobCodec<T extends object>(fields: {
  [Key in keyof T]: Field<T[Key]>;
}): JobCodec<T> {
  return {
    parse(raw) {
      const record: Partial<T> = {};
      for (const key in fields) {
        const value = raw[key];
        if (value === undefined) continue;
        const parsed = fields[key].parse(value);
        if (parsed !== undefined) record[key] = parsed;
      }
      return record;
    },
    serialize(record) {
      const raw: Record<string, string> = {};
      for (const key in fields) {
        const value = record[key];
        if (value !== undefined) raw[key] = fields[key].serialize(value);
      }
      return raw;
    },
  };
}

export const jobRecordFields = {
  version: textField,
  status: statusField,
  nextRunAt: timeField,
  attempts: attemptsField,
  startedAt: timeField,
  completedAt: timeField,
  lastError: textField,
  activeRunId: textField,
  recurring: flagField,
};

export type JobRecord = {
  [Key in keyof typeof jobRecordFields]: Exclude<
    ReturnType<(typeof jobRecordFields)[Key]["parse"]>,
    undefined
  >;
};
