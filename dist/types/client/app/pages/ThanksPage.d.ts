import type { SubGoalState } from '../../../shared/types/api';
type ThanksPageProps = {
    state: SubGoalState;
    onReturn: () => void;
    onVisitPromoSub: () => void;
    onCelebrate: () => void;
};
export declare const ThanksPage: ({ state, onReturn, onVisitPromoSub, onCelebrate, }: ThanksPageProps) => import("react/jsx-runtime").JSX.Element;
export {};
