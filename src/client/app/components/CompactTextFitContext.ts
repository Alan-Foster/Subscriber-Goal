import { createContext, useContext } from "react";

export type CompactTextFit = {
  fontSizePx: number;
  wrapCta: boolean;
};

const CompactTextFitContext = createContext<CompactTextFit | null>(null);

export const CompactTextFitProvider = CompactTextFitContext.Provider;

export const useCompactTextFit = (): CompactTextFit | null =>
  useContext(CompactTextFitContext);
