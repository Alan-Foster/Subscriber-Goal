import type { CrosspostDispatchResult } from "./subGoalData";
import { isRecord } from "../utils/runtimeValidation";

export function isCrosspostDispatchResult(
  value: unknown,
): value is CrosspostDispatchResult {
  return (
    isRecord(value) &&
    (value.status === "success" ||
      value.status === "skipped" ||
      value.status === "failed") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}
