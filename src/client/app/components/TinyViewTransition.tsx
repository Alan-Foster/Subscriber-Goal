import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion";

export const tinyViewTransitionDurationMs = 250;

type TinyViewTransitionProps = {
  transitionKey: string;
  children: ReactNode;
};

type OutgoingView = {
  key: string;
  content: ReactNode;
};

export const TinyViewTransition = ({
  transitionKey,
  children,
}: TinyViewTransitionProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const previousKeyRef = useRef(transitionKey);
  const previousContentRef = useRef(children);
  const cleanupTimerRef = useRef<number | null>(null);
  const [outgoingView, setOutgoingView] = useState<OutgoingView | null>(null);
  const [enteringKey, setEnteringKey] = useState<string | null>(null);

  if (previousKeyRef.current === transitionKey) {
    previousContentRef.current = children;
  }

  useLayoutEffect(() => {
    if (previousKeyRef.current === transitionKey) {
      return;
    }

    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    const outgoing = {
      key: previousKeyRef.current,
      content: previousContentRef.current,
    };
    previousKeyRef.current = transitionKey;
    previousContentRef.current = children;

    if (prefersReducedMotion) {
      setOutgoingView(null);
      setEnteringKey(null);
      return;
    }

    setOutgoingView(outgoing);
    setEnteringKey(transitionKey);
    cleanupTimerRef.current = window.setTimeout(() => {
      setOutgoingView(null);
      setEnteringKey(null);
      cleanupTimerRef.current = null;
    }, tinyViewTransitionDurationMs);
  }, [children, prefersReducedMotion, transitionKey]);

  useLayoutEffect(() => {
    if (!prefersReducedMotion) {
      return;
    }
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    setOutgoingView(null);
    setEnteringKey(null);
  }, [prefersReducedMotion]);

  useLayoutEffect(
    () => () => {
      if (cleanupTimerRef.current !== null) {
        window.clearTimeout(cleanupTimerRef.current);
      }
    },
    [],
  );

  return (
    <div className="relative h-full w-full" data-tiny-view-transition="true">
      {outgoingView ? (
        <div
          key={outgoingView.key}
          className="sg-tiny-view-exit pointer-events-none absolute inset-0"
          aria-hidden="true"
          data-tiny-transition-outgoing="true"
          inert
        >
          {outgoingView.content}
        </div>
      ) : null}
      <div
        className={`absolute inset-0 ${
          enteringKey === transitionKey ? "sg-tiny-view-enter" : ""
        }`}
        data-tiny-transition-active="true"
      >
        {children}
      </div>
    </div>
  );
};
