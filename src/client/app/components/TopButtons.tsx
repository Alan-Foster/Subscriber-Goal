import { useEffect } from 'react';

type TopButtonsProps = {
  onVisitPromoSubPressed: () => void;
  promoSubreddit: string;
};

let hasAnimatedOnce = false;

export const TopButtons = ({
  onVisitPromoSubPressed,
  promoSubreddit,
}: TopButtonsProps) => {
  const shouldAnimate = !hasAnimatedOnce;

  useEffect(() => {
    hasAnimatedOnce = true;
  }, []);

  return (
    <div className="absolute right-4 top-4">
      <button
        type="button"
        aria-label={`View r/${promoSubreddit}`}
        className={`${
          shouldAnimate ? 'sg-fade-in' : ''
        } cursor-pointer border-0 bg-transparent p-0 leading-none text-[color:var(--sg-text-secondary)] transition hover:text-[color:var(--sg-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--sg-border-strong)]`}
        onClick={onVisitPromoSubPressed}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M10 1C5.029 1 1 5.029 1 10C1 14.971 5.029 19 10 19C14.971 19 19 14.971 19 10C19 5.029 14.971 1 10 1ZM10 17.2C8.34 17.2 6.814 16.63 5.595 15.683L12.071 9.206V13H13.872V7.028C13.872 6.531 13.469 6.128 12.972 6.128H7.032V7.929H10.803L4.322 14.411C3.372 13.191 2.801 11.663 2.801 10.001C2.801 6.031 6.031 2.801 10.001 2.801C13.971 2.801 17.201 6.031 17.201 10.001C17.201 13.971 13.971 17.201 10.001 17.201L10 17.2Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
};
