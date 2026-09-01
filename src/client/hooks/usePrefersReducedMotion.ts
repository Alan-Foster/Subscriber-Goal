import { useEffect, useState } from "react";

export const reducedMotionMediaQuery = "(prefers-reduced-motion: reduce)";

const getMatches = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(reducedMotionMediaQuery).matches
    : false;

export const usePrefersReducedMotion = (): boolean => {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getMatches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setPrefersReducedMotion(false);
      return;
    }

    const mediaQuery = window.matchMedia(reducedMotionMediaQuery);
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
};
