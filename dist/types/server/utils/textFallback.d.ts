export type TextFallbackProps = {
    goal: number;
    subscribers: number;
    subredditName: string;
    completedTime: Date | null;
};
export declare const textFallbackMaker: (props: TextFallbackProps) => string;
export declare const applyTextFallback: (post: unknown, props: TextFallbackProps) => Promise<void>;
