import { createContext, useState, useEffect } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import {
  ENABLE_REALTIME,
  REALTIME_SOCKET_OPTIONS,
  REALTIME_SOCKET_URL,
} from "../lib/realtime";

export const AuthContext = createContext();

const BASE_URL = import.meta.env.VITE_API_URL || "";
const API_URL = `${BASE_URL}/api`;

const AuthProvider = ({ children }) => {
  const [userData, setUserData] = useState({ employees: [], admin: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
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

    const socket = io(REALTIME_SOCKET_URL, REALTIME_SOCKET_OPTIONS);

    socket.on("employeeUpdated", ({ email, employee }) => {
      setUserData((prev) => ({
        ...prev,
        employees: prev.employees.map((e) =>
          e.email === email ? employee : e,
        ),
      }));
    });

    socket.on("taskCreated", ({ email, task }) => {
      setUserData((prev) => ({
        ...prev,
        employees: prev.employees.map((e) =>
          e.email === email ? { ...e, tasks: [...e.tasks, task] } : e,
        ),
      }));
    });

    socket.on(
      "taskExplanationGenerated",
      ({ employeeEmail, updatedEmployee }) => {
        if (updatedEmployee) {
          setUserData((prev) => ({
            ...prev,
            employees: prev.employees.map((e) =>
              e.email === employeeEmail ? updatedEmployee : e,
            ),
          }));
        }
      },
    );

    socket.on("taskStatusChanged", ({ email, employee }) => {
      if (employee) {
        setUserData((prev) => ({
          ...prev,
          employees: prev.employees.map((e) =>
            e.email === email ? employee : e,
          ),
        }));
      }
    });

    return () => {
      socket.disconnect();
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
