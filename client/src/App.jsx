import React, { useEffect, useState } from "react";
import Login from "./components/Auth/Login";
import EmployeeDashboard from "./components/Dashboard/EmployeeDashboard";
import AdminDashboard from "./components/Dashboard/AdminDashboard";

const BASE_URL = import.meta.env.VITE_API_URL || "";

const App = () => {
  const [user, setUser] = useState("");
  const [loggedInUserData, setLoggedInUserData] = useState(null);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    const loggedInUser = localStorage.getItem("loggedInUser");
    if (!loggedInUser) return;

    const userData = JSON.parse(loggedInUser);
    setUser(userData.role);
    if (userData.role === "employee") {
      setLoggedInUserData(userData.data || null);
    }
  }, []);

  const handleLogin = async (email, password) => {
    setAuthLoading(true);
    setAuthError("");

    try {
      const res = await fetch(
        `${BASE_URL}/api/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      const payload = await res.json();

      if (!res.ok) {
        if (res.status === 403 && payload?.requiresPasswordSetup) {
          setAuthError(
            "Account not activated yet. Please use Sign up to set your password.",
          );
          return;
        }
        setAuthError(payload?.error || "Invalid credentials");
        return;
      }

      if (payload?.success && payload?.role === "admin") {
        setLoggedInUserData(null);
        setUser("admin");
        localStorage.setItem("loggedInUser", JSON.stringify({ role: "admin" }));
        return;
      }

      if (
        payload?.success &&
        payload?.role === "employee" &&
        payload?.employee
      ) {
        setUser("employee");
        setLoggedInUserData(payload.employee);
        localStorage.setItem(
          "loggedInUser",
          JSON.stringify({ role: "employee", data: payload.employee }),
        );
        return;
      }

      setAuthError("Login failed. Please try again.");
    } catch (err) {
      console.error("Login error:", err);
      setAuthError("Login failed. Please try again.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignup = async (email, newPassword, options = {}) => {
    if (options?.clientError) {
      setAuthError(options.clientError);
      return;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      const res = await fetch(
        `${BASE_URL}/api/auth/signup`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            newPassword,
          }),
        },
      );
      const payload = await res.json();

      if (!res.ok) {
        setAuthError(payload?.error || "Unable to sign up");
        return;
      }

      await handleLogin(email, newPassword);
    } catch (err) {
      console.error("Sign up error:", err);
      setAuthError("Unable to sign up. Please retry.");
    } finally {
      setAuthLoading(false);
    }
  };

  return (
    <>
      {!user ? (
        <Login
          handleLogin={handleLogin}
          handleSignup={handleSignup}
          errorMessage={authError}
          loading={authLoading}
        />
      ) : user === "admin" ? (
        <AdminDashboard />
      ) : user === "employee" && loggedInUserData ? (
        <EmployeeDashboard data={loggedInUserData} />
      ) : null}
    </>
  );
};

export default App;
