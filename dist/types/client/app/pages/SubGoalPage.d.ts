import type { SubGoalState } from '../../../shared/types/api';
type SubGoalPageProps = {
    state: SubGoalState;
    onSubscribe: () => void;
    onCelebrate: () => void;
    onVisitPromoSub: () => void;
    isSubmitting: boolean;
    shareUsername: boolean;
    onShareUsernameChange: (value: boolean) => void;
    notice: string | null;
};
export declare const SubGoalPage: ({ state, onSubscribe, onCelebrate, onVisitPromoSub, isSubmitting, shareUsername, onShareUsernameChange, notice, }: SubGoalPageProps) => import("react/jsx-runtime").JSX.Element;
export {};
