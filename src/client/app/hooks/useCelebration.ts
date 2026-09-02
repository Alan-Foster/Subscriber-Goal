import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";
import { confettiPresets } from "../confettiPresets";

export type CelebrationOptions = {
  pieceCount?: number;
  durationMs?: number;
  allowRestart?: boolean;
};

const interactiveTargetSelector = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "option",
  "label",
  '[role="button"]',
  '[role="link"]',
  '[contenteditable]:not([contenteditable="false"])',
  '[data-celebration-interactive="true"]',
].join(",");

const isInteractiveTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(interactiveTargetSelector) !== null;

export const useCelebration = () => {
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationKey, setCelebrationKey] = useState(0);
  const [pieceCount, setPieceCount] = useState<number>(
    confettiPresets.default.pieceCount,
  );
  const timeoutRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(
    () => () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const triggerCelebration = useCallback(
    ({
      pieceCount: nextPieceCount = confettiPresets.default.pieceCount,
      durationMs = confettiPresets.default.durationMs,
      allowRestart = true,
    }: CelebrationOptions = {}) => {
      if (activeRef.current && !allowRestart) return;

      activeRef.current = true;
      setCelebrationKey((previous) => previous + 1);
      setPieceCount(nextPieceCount);
      setShowCelebration(true);
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        activeRef.current = false;
        setShowCelebration(false);
      }, durationMs);
    },
    [],
  );

  const onPointerDownCapture = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (!isInteractiveTarget(event.target)) {
        triggerCelebration(confettiPresets.click);
      }
    },
    [triggerCelebration],
  );
  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.detail === 0 && !isInteractiveTarget(event.target)) {
        triggerCelebration(confettiPresets.click);
      }
    },
    [triggerCelebration],
  );

  return {
    celebrationKey,
    interactionHandlers: { onPointerDownCapture, onClickCapture },
    pieceCount,
    prefersReducedMotion,
    showCelebration,
    triggerCelebration,
  };
};
