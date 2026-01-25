import { type CSSProperties } from 'react';
type ProgressBarProps = {
    start?: number;
    end?: number;
    current?: number;
    showText?: boolean;
    width?: CSSProperties['width'];
};
export declare const ProgressBar: ({ start, end, current, showText, width, }: ProgressBarProps) => import("react/jsx-runtime").JSX.Element;
export {};
