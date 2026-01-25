import type { SubGoalState } from '../../../shared/types/api';
type CompletedPageProps = {
    state: SubGoalState;
    onVisitPromoSub: () => void;
    onCelebrate: () => void;
};
export declare const CompletedPage: ({ state, onVisitPromoSub, onCelebrate, }: CompletedPageProps) => import("react/jsx-runtime").JSX.Element;
export {};
