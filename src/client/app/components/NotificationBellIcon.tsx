type NotificationBellIconProps = {
  enabled?: boolean | undefined;
  size?: number;
};

export const NotificationBellIcon = ({
  enabled,
  size = 20,
}: NotificationBellIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    data-notification-bell-state={
      enabled === undefined ? "unknown" : enabled ? "enabled" : "disabled"
    }
  >
    <path
      d="M10 1.75a5.25 5.25 0 0 0-5.25 5.25v2.23c0 .78-.25 1.54-.72 2.16L2.7 13.17a1 1 0 0 0 .8 1.6h13a1 1 0 0 0 .8-1.6l-1.33-1.78a3.6 3.6 0 0 1-.72-2.16V7A5.25 5.25 0 0 0 10 1.75Zm0 16.5a2.51 2.51 0 0 0 2.38-1.75H7.62A2.51 2.51 0 0 0 10 18.25Z"
      fill="currentColor"
    />
    {enabled === false ? (
      <path
        d="M3 3l14 14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    ) : null}
  </svg>
);
