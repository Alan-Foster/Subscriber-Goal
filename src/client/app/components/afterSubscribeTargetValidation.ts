import type {
  AfterSubscribeTargetResponse,
  NavigationTarget,
} from "../../../shared/types/api";

export function isAfterSubscribeTargetResponse(
  payload: unknown,
): payload is AfterSubscribeTargetResponse {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    "target" in payload &&
    hasUsableNavigationTarget((payload as AfterSubscribeTargetResponse).target),
  );
}

function hasUsableNavigationTarget(
  target: unknown,
): target is NavigationTarget {
  if (
    typeof target !== "object" ||
    target === null ||
    !("url" in target) ||
    typeof target.url !== "string" ||
    target.url.trim().length === 0
  ) {
    return false;
  }
  try {
    const url = new URL(target.url);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.length > 0 &&
      (!("permalink" in target) ||
        target.permalink === undefined ||
        typeof target.permalink === "string")
    );
  } catch {
    // diagnostic-allow-silent: malformed navigation targets are validation input.
    return false;
  }
}
