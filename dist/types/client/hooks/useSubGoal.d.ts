import type { DebugRealtimeRequest, SubGoalState, SubscribeRequest } from '../../shared/types/api';
type SubscribeResult = {
    state: SubGoalState | null;
    error: string | null;
};
export declare const useSubGoal: () => {
    readonly state: SubGoalState | null;
    readonly loading: boolean;
    readonly submitting: boolean;
    readonly error: string | null;
    readonly refresh: () => Promise<SubGoalState | null>;
    readonly subscribe: (payload?: SubscribeRequest) => Promise<SubscribeResult>;
    readonly simulateSubscribe: (shareUsername: boolean) => SubGoalState | null;
    readonly simulateIncrement: () => SubGoalState | null;
    readonly sendDebugRealtime: (payload: DebugRealtimeRequest) => Promise<string | null>;
    readonly setError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
    readonly notice: string | null;
    readonly showNotice: (message: string) => void;
};
export {};
