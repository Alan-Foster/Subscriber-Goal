import type { CreateSubscriberGoalFollowUpFormValues } from "../../shared/types/api";
import { isCreationAttemptId } from "../data/createGoalDraft";

const creationAttemptFieldMarker = "__creation_attempt__";

export function creationAttemptFieldName(
  fieldName: string,
  creationAttemptId: string,
): string {
  return `${fieldName}${creationAttemptFieldMarker}${creationAttemptId}`;
}

export function readCreationAttemptCallback<T extends Record<string, unknown>>(
  rawValues: T,
  carrierFieldName: string,
): { creationAttemptId: string; values: T } | undefined {
  const prefix = `${carrierFieldName}${creationAttemptFieldMarker}`;
  const matches = Object.keys(rawValues).filter((key) =>
    key.startsWith(prefix),
  );
  if (matches.length !== 1) return undefined;
  const encodedFieldName = matches[0]!;
  const creationAttemptId = encodedFieldName.slice(prefix.length);
  if (!isCreationAttemptId(creationAttemptId)) return undefined;
  return {
    creationAttemptId,
    values: {
      ...rawValues,
      [carrierFieldName]: rawValues[encodedFieldName],
    },
  };
}

export type CreateGoalFollowUpValues = CreateSubscriberGoalFollowUpFormValues;
