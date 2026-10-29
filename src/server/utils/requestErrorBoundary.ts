import type { ErrorRequestHandler } from "express";
import type { UiResponse } from "@devvit/web/shared";
import type { ErrorResponse } from "../../shared/types/api";
import { context, reddit } from "@devvit/web/server";
import { createOperationId, logDiagnostic } from "../../shared/diagnostics";
import { resolveAppLanguage, translate } from "../../shared/i18n/catalog";

export const unhandledRequestErrorHandler: ErrorRequestHandler = async (
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
    let language = resolveAppLanguage(undefined);
    try {
      language = resolveAppLanguage(
        (await reddit.getCurrentSubreddit()).language,
      );
    } catch (languageError) {
      logDiagnostic(
        "warn",
        "request_error_language_resolution_failed",
        {
          operationId,
          route: req.path,
          phase: "language_resolution",
        },
        languageError,
      );
    }
    res.status(200).json({
      showToast: translate(language, "errors.request.actionFailed", {
        operationId,
      }),
    } satisfies UiResponse);
    return;
  }
  res.status(req.path.startsWith("/api/") ? 503 : 500).json({
    status: "error",
    message: translate("en", "errors.request.failed", { operationId }),
    messageKey: "errors.request.failed",
    messageParams: { operationId },
  } satisfies ErrorResponse);
};
