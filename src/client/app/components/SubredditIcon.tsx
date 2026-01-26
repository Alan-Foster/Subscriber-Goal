import { LoadingElement } from './LoadingElement';

type SubredditIconProps = {
  iconUrl?: string;
  size?: number;
  onClick?: () => void;
};

export const SubredditIcon = ({
  iconUrl,
  size = 100,
  onClick,
}: SubredditIconProps) => {
  const dimensionStyle = { width: size, height: size };
  return (
    <div
      className="flex items-center justify-center rounded-full bg-[color:var(--sg-surface)]"
      style={dimensionStyle}
    >
      <LoadingElement isLoading={!iconUrl} className="h-full w-full">
        {iconUrl ? (
          <img
            src={iconUrl}
            alt="Subreddit icon"
            className={`h-full w-full rounded-full object-cover ${
              onClick ? 'cursor-pointer' : ''
            }`}
            onClick={onClick}
          />
        ) : null}
      </LoadingElement>
    </div>
  );
};
