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

export type CelebrationBurst = {
  id: number;
  pieceCount: number;
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

export const isCelebrationInteractiveTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(interactiveTargetSelector) !== null;

export const useCelebration = () => {
  const [celebrationBursts, setCelebrationBursts] = useState<
    CelebrationBurst[]
  >([]);
  const nextBurstIdRef = useRef(0);
  const activeBurstIdsRef = useRef(new Set<number>());
  const timeoutIdsRef = useRef(new Map<number, number>());
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(
    () => () => {
      for (const timeoutId of timeoutIdsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      timeoutIdsRef.current.clear();
      activeBurstIdsRef.current.clear();
    },
    [],
  );

  const triggerCelebration = useCallback(
    ({
      pieceCount: nextPieceCount = confettiPresets.default.pieceCount,
      durationMs = confettiPresets.default.durationMs,
      allowRestart = true,
    }: CelebrationOptions = {}) => {
      if (activeBurstIdsRef.current.size > 0 && !allowRestart) return;

      const id = nextBurstIdRef.current + 1;
      nextBurstIdRef.current = id;
      activeBurstIdsRef.current.add(id);
      setCelebrationBursts((previous) => [
        ...previous,
        { id, pieceCount: nextPieceCount },
      ]);
      const timeoutId = window.setTimeout(() => {
        activeBurstIdsRef.current.delete(id);
        timeoutIdsRef.current.delete(id);
        setCelebrationBursts((previous) =>
          previous.filter((burst) => burst.id !== id),
        );
      }, durationMs);
      timeoutIdsRef.current.set(id, timeoutId);
    },
    [],
  );

  const onPointerDownCapture = useCallback<PointerEventHandler<HTMLDivElement>>(
    (event) => {
      if (!isCelebrationInteractiveTarget(event.target)) {
        triggerCelebration(confettiPresets.click);
      }
    },
    [triggerCelebration],
  );
  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.detail === 0 && !isCelebrationInteractiveTarget(event.target)) {
        triggerCelebration(confettiPresets.click);
      }
    },
    [triggerCelebration],
  );

  return {
    celebrationBursts,
    interactionHandlers: { onPointerDownCapture, onClickCapture },
    prefersReducedMotion,
    triggerCelebration,
  };
};
