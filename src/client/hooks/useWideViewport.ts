import { useEffect, useState } from "react";

export const wideViewportMediaQuery = "(min-width: 640px)";

const getMatches = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(wideViewportMediaQuery).matches
    : false;

export const useWideViewport = (): boolean => {
  const [isWide, setIsWide] = useState(getMatches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setIsWide(false);
      return;
    }

    const mediaQuery = window.matchMedia(wideViewportMediaQuery);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsWide(event.matches);
    };

    setIsWide(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isWide;
};
