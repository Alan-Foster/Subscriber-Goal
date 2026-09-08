import type { ErrorRequestHandler } from "express";
import type { UiResponse } from "@devvit/web/shared";
import type { ErrorResponse } from "../../shared/types/api";
import { context } from "@devvit/web/server";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";

export const unhandledRequestErrorHandler: ErrorRequestHandler = (
  error,
  req,
  res,
  next,
) => {
  const operationId = createOperationId("request");
  logDiagnostic(
    "error",
    "unhandled_request_error",
    {
      operationId,
      route: req.path,
      phase: "unhandled",
      postId: context.postId,
      status: 500,
      method: req.method,
    },
    error,
  );

  if (res.headersSent) {
    next(error);
    return;
  }
  if (
    req.path.startsWith("/internal/menu/") ||
    req.path.startsWith("/internal/form/")
  ) {
    res.status(200).json({
      showToast: `The selected action failed. Reference: ${operationId}`,
    } satisfies UiResponse);
    return;
  }
  res.status(req.path.startsWith("/api/") ? 503 : 500).json({
    status: "error",
    message: `The request could not be completed. Reference: ${operationId}`,
  } satisfies ErrorResponse);
};
