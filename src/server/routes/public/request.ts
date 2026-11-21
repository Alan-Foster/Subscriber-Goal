import type { Request } from "express";
import { context } from "@devvit/web/server";
import type { ErrorResponse } from "../../../shared/types/api";
import { translate, type MessageKey } from "../../../shared/i18n/catalog";

export const localizedError = (
  messageKey: MessageKey,
  messageParams: Record<string, string | number> = {},
): ErrorResponse => ({
  status: "error",
  message: translate("en", messageKey, messageParams),
  messageKey,
  ...(Object.keys(messageParams).length > 0 ? { messageParams } : {}),
});

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requestHeader = (
  req: Request,
  name: string,
): string | undefined => {
  const value = req.header?.(name)?.trim();
  return value && uuidPattern.test(value) ? value : undefined;
};

export const visitorIdentity = (req: Request): string | undefined =>
  context.userId ?? requestHeader(req, "X-SG-Visitor-ID");
