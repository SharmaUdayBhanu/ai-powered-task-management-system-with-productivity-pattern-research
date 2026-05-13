import { createContext, useState, useEffect } from "react";
import axios from "axios";
import { ENABLE_REALTIME } from "../lib/realtime";
import getSocket from "../lib/socket";

export const AuthContext = createContext();

const BASE_URL = import.meta.env.VITE_API_URL || "";
const API_URL = `${BASE_URL}/api`;
const ENABLE_AUTH_PREFETCH =
  import.meta.env.VITE_ENABLE_AUTH_PREFETCH === "true";

const AuthProvider = ({ children }) => {
  const [userData, setUserData] = useState({ employees: [], admin: [] });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ENABLE_AUTH_PREFETCH) {
      return undefined;
    }

    const fetchData = async () => {
      setLoading(true);
      try {
        const empRes = await axios.get(`${API_URL}/employees`);
        setUserData({ employees: empRes.data });
      } catch (err) {
        setUserData({ employees: [], admin: [] });
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    if (!ENABLE_REALTIME) {
      return undefined;
    }

    const socket = getSocket();

    const onEmployeeUpdated = ({ email, employee }) => {
      setUserData((prev) => ({
        ...prev,
        employees: prev.employees.map((e) =>
          e.email === email ? employee : e,
        ),
      }));
    };

    const onTaskCreated = ({ email, task }) => {
      setUserData((prev) => ({
        ...prev,
        employees: prev.employees.map((e) =>
          e.email === email ? { ...e, tasks: [...(e.tasks || []), task] } : e,
        ),
      }));
    };

    const onTaskExplanationGenerated = ({ employeeEmail, updatedEmployee }) => {
      if (updatedEmployee) {
        setUserData((prev) => ({
          ...prev,
          employees: prev.employees.map((e) =>
            e.email === employeeEmail ? updatedEmployee : e,
          ),
        }));
      }
    };

    const onTaskStatusChanged = ({ email, employee }) => {
      if (employee) {
        setUserData((prev) => ({
          ...prev,
          employees: prev.employees.map((e) =>
            e.email === email ? employee : e,
          ),
        }));
      }
    };

    if (socket) {
      socket.on("employeeUpdated", onEmployeeUpdated);
      socket.on("taskCreated", onTaskCreated);
      socket.on("taskExplanationGenerated", onTaskExplanationGenerated);
      socket.on("taskStatusChanged", onTaskStatusChanged);
    }

    return () => {
      if (socket) {
        socket.off("employeeUpdated", onEmployeeUpdated);
        socket.off("taskCreated", onTaskCreated);
        socket.off("taskExplanationGenerated", onTaskExplanationGenerated);
        socket.off("taskStatusChanged", onTaskStatusChanged);
      }
    };
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <AuthContext.Provider value={userData}>{children}</AuthContext.Provider>
    </div>
  );
};

export default AuthProvider;
