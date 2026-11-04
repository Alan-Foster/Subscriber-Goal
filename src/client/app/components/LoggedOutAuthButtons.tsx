type LoggedOutAuthButtonsProps = {
  signUpLabel: string;
  logInLabel: string;
  onAuthenticate: () => void;
};

export const LoggedOutAuthButtons = ({
  signUpLabel,
  logInLabel,
  onAuthenticate,
}: LoggedOutAuthButtonsProps) => (
  <div
    className="flex w-full max-w-[520px] items-stretch justify-center gap-3"
    data-logged-out-auth-buttons="true"
    data-subgoal-primary-cta="true"
  >
    <button
      type="button"
      className="sg-hover-grow inline-flex min-h-[60px] min-w-0 flex-1 cursor-pointer items-center justify-center rounded-full bg-[#343a40] px-4 py-2 text-center text-lg font-semibold whitespace-normal text-white [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      onClick={onAuthenticate}
    >
      {signUpLabel}
    </button>
    <button
      type="button"
      className="sg-hover-grow inline-flex min-h-[60px] min-w-0 flex-1 cursor-pointer items-center justify-center rounded-full bg-[#ff4500] px-4 py-2 text-center text-lg font-semibold whitespace-normal text-white [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      onClick={onAuthenticate}
    >
      {logInLabel}
    </button>
  </div>
);
