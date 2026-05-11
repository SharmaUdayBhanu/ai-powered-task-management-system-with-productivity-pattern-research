import React, { useState } from "react";

const Login = ({
  handleLogin,
  handleSignup,
  onForgotPassword,
  errorMessage = "",
  loading = false,
}) => {
  const [mode, setMode] = useState("signin");
  const [signinEmail, setSigninEmail] = useState("");
  const [signinPassword, setSigninPassword] = useState("");
  const [showSigninPassword, setShowSigninPassword] = useState(false);
  const [forgotMessage, setForgotMessage] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupConfirmPassword, setSignupConfirmPassword] = useState("");

  const handleSigninSubmit = (e) => {
    e.preventDefault();
    handleLogin(signinEmail, signinPassword);
  };

  const handleForgotPassword = () => {
    if (typeof onForgotPassword === "function") {
      onForgotPassword(signinEmail, setForgotMessage);
      return;
    }

    setForgotMessage(
      "Please contact your administrator to reset your password.",
    );
  };

  const handleSignupSubmit = (e) => {
    e.preventDefault();

    if (signupPassword !== signupConfirmPassword) {
      handleSignup(null, null, {
        clientError: "Passwords do not match.",
      });
      return;
    }

    handleSignup(signupEmail, signupPassword);
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-gray-100 p-1">
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "signin" ? "bg-white shadow text-black" : "text-gray-600"}`}
            onClick={() => setMode("signin")}
          >
            Sign in
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "signup" ? "bg-white shadow text-black" : "text-gray-600"}`}
            onClick={() => setMode("signup")}
          >
            Sign up
          </button>
        </div>

        {mode === "signin" ? (
          <form onSubmit={handleSigninSubmit} className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold">Sign in</h1>
            </div>
            <div>
              <input
                type="email"
                value={signinEmail}
                onChange={(e) => setSigninEmail(e.target.value)}
                className="w-full px-4 py-2 border-b border-gray-300 focus:outline-none focus:border-black bg-transparent"
                placeholder="email"
                required
              />
            </div>
            <div className="relative">
              <input
                type={showSigninPassword ? "text" : "password"}
                value={signinPassword}
                onChange={(e) => setSigninPassword(e.target.value)}
                className="w-full px-4 py-2 pr-10 border-b border-gray-300 focus:outline-none focus:border-black bg-transparent"
                placeholder="password"
                required
              />
              <button
                type="button"
                onClick={() => setShowSigninPassword((prev) => !prev)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-800"
                aria-label={
                  showSigninPassword ? "Hide password" : "Show password"
                }
                title={showSigninPassword ? "Hide password" : "Show password"}
              >
                {showSigninPassword ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="3.5" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                  >
                    <path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
                    <circle cx="12" cy="12" r="3.5" />
                    <path d="M4 20L20 4" />
                  </svg>
                )}
              </button>
            </div>
            <div className="flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={handleForgotPassword}
                className="text-gray-600 hover:text-black"
              >
                Forgot password?
              </button>
              {forgotMessage && (
                <span className="text-gray-500">{forgotMessage}</span>
              )}
            </div>
            {errorMessage && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage}
              </div>
            )}
            <button
              type="submit"
              className="w-full py-2 bg-black text-white rounded hover:bg-gray-800 focus:outline-none"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Log in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSignupSubmit} className="space-y-4">
            <div>
              <h1 className="text-xl font-semibold">Sign up</h1>
              <p className="mt-1 text-xs text-gray-600">
                Use your admin-created employee email to activate your account.
              </p>
            </div>
            <div>
              <input
                type="email"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                className="w-full px-4 py-2 border-b border-gray-300 focus:outline-none focus:border-black bg-transparent"
                placeholder="employee email"
                required
              />
            </div>
            <div>
              <input
                type="password"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
                className="w-full px-4 py-2 border-b border-gray-300 focus:outline-none focus:border-black bg-transparent"
                placeholder="set password"
                required
                minLength={6}
              />
            </div>
            <div>
              <input
                type="password"
                value={signupConfirmPassword}
                onChange={(e) => setSignupConfirmPassword(e.target.value)}
                className="w-full px-4 py-2 border-b border-gray-300 focus:outline-none focus:border-black bg-transparent"
                placeholder="confirm password"
                required
                minLength={6}
              />
            </div>
            {errorMessage && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {errorMessage}
              </div>
            )}
            <button
              type="submit"
              className="w-full py-2 bg-black text-white rounded hover:bg-gray-800 focus:outline-none"
              disabled={loading}
            >
              {loading ? "Creating account..." : "Set password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default Login;
