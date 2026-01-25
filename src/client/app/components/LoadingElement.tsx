import type { ReactNode } from 'react';

type LoadingElementProps = {
  isLoading: boolean;
  className?: string;
  children: ReactNode;
};

export const LoadingElement = ({
  isLoading,
  className = 'h-6 w-6',
  children,
}: LoadingElementProps) => {
  if (!isLoading) {
    return <>{children}</>;
  }
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="h-full w-full animate-pulse rounded-full bg-[color:var(--sg-surface-muted)]" />
    </div>
  );
};
