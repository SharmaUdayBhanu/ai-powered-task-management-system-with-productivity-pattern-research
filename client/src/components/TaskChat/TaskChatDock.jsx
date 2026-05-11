import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, X, Send, Lock, CheckCircle2 } from "lucide-react";
import axios from "axios";
import { io } from "socket.io-client";
import API_URL from "../../lib/apiClient";
import {
  ENABLE_REALTIME,
  REALTIME_SOCKET_OPTIONS,
  REALTIME_SOCKET_URL,
} from "../../lib/realtime";

const buildTaskKey = ({ groupId, taskId }) =>
  groupId ? `group:${groupId}` : `task:${taskId}`;

const formatTimestamp = (value) => {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const normalizeEmail = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeTasks = ({ tasks = [], isAdmin = false }) => {
  const groupMap = new Map();
  const singleTasks = [];

  tasks.forEach((task) => {
    if (!task || task.isDeleted) return;
    if (task.groupTask && task.groupId) {
      if (!groupMap.has(task.groupId)) {
        groupMap.set(task.groupId, {
          key: buildTaskKey({ groupId: task.groupId }),
          groupId: task.groupId,
          taskId: null,
          title: task.taskTitle || "Group task",
          category: task.category || "General",
          active: Boolean(task.active),
          completed: Boolean(task.completed),
          chatEnabled: true,
          chatClosed: Boolean(task.chatClosed),
          ownerEmail: null,
          ownerName: "Group",
          memberCount: Array.isArray(task.groupMembers)
            ? task.groupMembers.length
            : 0,
        });
      }
      return;
    }

    if (task.notAccepted) return;

    const chatEnabled = Boolean(task.chatEnabled);
    if (!chatEnabled && !isAdmin) {
      // Single-task chat is always allowed for the owner.
    }

    singleTasks.push({
      key: buildTaskKey({ taskId: task._id }),
      groupId: null,
      taskId: task._id,
      title: task.taskTitle || "Task",
      category: task.category || "General",
      active: Boolean(task.active),
      completed: Boolean(task.completed),
      chatEnabled,
      chatClosed: Boolean(task.chatClosed),
      ownerEmail: task.ownerEmail,
      ownerName: task.ownerName || task.ownerEmail || "Employee",
      memberCount: 1,
    });
  });

  const grouped = Array.from(groupMap.values());
  const combined = [...grouped, ...singleTasks];

  return combined.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return (a.title || "").localeCompare(b.title || "");
  });
};

const TaskChatDock = ({
  tasks = [],
  user = {},
  theme = "dark",
  isAdmin = false,
}) => {
  const isDark = theme === "dark";
  const [isOpen, setIsOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageText, setMessageText] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [error, setError] = useState("");
  const [assistantError, setAssistantError] = useState("");
  const [unreadByTask, setUnreadByTask] = useState({});
  const [notifications, setNotifications] = useState([]);
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const optimisticRef = useRef(new Map());
  const privateAssistantByTaskRef = useRef(new Map());

  const chatTasks = useMemo(
    () => normalizeTasks({ tasks, isAdmin }),
    [tasks, isAdmin],
  );

  const selectedTask = useMemo(
    () => chatTasks.find((task) => task.key === selectedKey) || null,
    [chatTasks, selectedKey],
  );

  const selectedTaskDetails = useMemo(() => {
    if (!selectedTask) return null;
    if (selectedTask.groupId) {
      return (
        tasks.find((task) => task.groupId === selectedTask.groupId) || null
      );
    }
    if (selectedTask.taskId) {
      return (
        tasks.find(
          (task) => String(task._id) === String(selectedTask.taskId),
        ) || null
      );
    }
    return null;
  }, [selectedTask, tasks]);

  const isSingleOwner = Boolean(
    selectedTask &&
      !selectedTask.groupId &&
      (!selectedTask.ownerEmail ||
        normalizeEmail(user.email) === normalizeEmail(selectedTask.ownerEmail)),
  );
  const canChat = Boolean(
    selectedTask &&
      (selectedTask.groupId
        ? !selectedTask.chatClosed
        : isSingleOwner),
  );

  const hasUnread = useMemo(
    () => Object.values(unreadByTask).some((count) => count > 0),
    [unreadByTask],
  );

  useEffect(() => {
    if (!chatTasks.length) return;
    if (!selectedKey || !chatTasks.find((task) => task.key === selectedKey)) {
      setSelectedKey(chatTasks[0].key);
    }
  }, [chatTasks, selectedKey]);

  useEffect(() => {
    if (selectedTask && !selectedTask.groupId) {
      setIsOpen(true);
    }
  }, [selectedTask]);

  const isAcceptedNotice = useCallback((message) => {
    if (message?.type !== "system") return false;
    return /accepted/i.test(String(message.message || ""));
  }, []);

  const isSubtaskNotice = useCallback((message) => {
    if (message?.type !== "system") return false;
    return /completed\s+a\s+subtask/i.test(String(message.message || ""));
  }, []);

  const filterMessagesForTask = useCallback(
    (baseMessages, task) => {
      if (!task) return [];
      const isGroup = Boolean(task.groupId);
      const normalizedUserEmail = normalizeEmail(user.email);
      const isOwner =
        isGroup || normalizeEmail(task.ownerEmail) === normalizedUserEmail;

      return (baseMessages || []).filter((message) => {
        if (!message) return false;
        if (isSubtaskNotice(message)) return false;
        const isSystem = message.type === "system";
        const isAssistant = message.type === "assistant";
        const isAdmin =
          message.senderRole === "admin" ||
          normalizeEmail(message.senderEmail) === "admin";
        const isOwn =
          normalizeEmail(message.senderEmail) === normalizedUserEmail &&
          !isAssistant &&
          !isSystem;

        if (isSystem) {
          return isAcceptedNotice(message);
        }

        if (!isGroup) {
          if (!isOwner) return false;
          return isOwn || isAssistant;
        }

        return isAssistant || isAdmin || isOwn || !isSystem;
      });
    },
    [isAcceptedNotice, isSubtaskNotice, user.email],
  );

  const mergePrivateAssistant = useCallback((baseMessages, taskKey) => {
    const privateMessages =
      privateAssistantByTaskRef.current.get(taskKey) || [];
    if (privateMessages.length === 0) return baseMessages;
    const existing = new Set(
      baseMessages.map((message) => String(message.messageId || "")),
    );
    const merged = [...baseMessages];
    privateMessages.forEach((message) => {
      if (!existing.has(String(message.messageId || ""))) {
        merged.push(message);
      }
    });
    return merged;
  }, []);

  const fetchChatMessages = useCallback(async () => {
    if (!selectedTask) return;
    setLoading(true);
    setError("");

    try {
      if (selectedTask.groupId) {
        const response = await axios.get(
          `${API_URL}/group-tasks/${selectedTask.groupId}/chat`,
        );
        const serverMessages = filterMessagesForTask(
          response.data?.messages || [],
          selectedTask,
        );
        setMessages(mergePrivateAssistant(serverMessages, selectedTask.key));
      } else if (selectedTask.taskId && selectedTask.ownerEmail) {
        const response = await axios.get(
          `${API_URL}/employees/${selectedTask.ownerEmail}/tasks/${selectedTask.taskId}/chat`,
        );
        const serverMessages = filterMessagesForTask(
          response.data?.messages || [],
          selectedTask,
        );
        setMessages(mergePrivateAssistant(serverMessages, selectedTask.key));
      }
      setUnreadByTask((prev) => ({
        ...prev,
        [selectedTask.key]: 0,
      }));
    } catch (err) {
      setError("Unable to load chat messages.");
    } finally {
      setLoading(false);
    }
  }, [selectedTask, mergePrivateAssistant, filterMessagesForTask]);

  useEffect(() => {
    fetchChatMessages();
  }, [fetchChatMessages]);

  useEffect(() => {
    if (!isOpen || !selectedTask) return undefined;
    const intervalId = window.setInterval(() => {
      fetchChatMessages();
    }, 12_000);

    return () => window.clearInterval(intervalId);
  }, [fetchChatMessages, isOpen, selectedTask]);

  const scrollToBottom = (behavior = "smooth") => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior,
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    if (atBottomRef.current) {
      scrollToBottom("smooth");
    }
  }, [messages, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!ENABLE_REALTIME) return undefined;

    const socket = io(REALTIME_SOCKET_URL, REALTIME_SOCKET_OPTIONS);

    socket.on("taskChatMessage", (payload) => {
      const message = payload?.message;
      if (!message) return;
      if (isSubtaskNotice(message)) return;
      const key = payload.groupId
        ? buildTaskKey({ groupId: payload.groupId })
        : buildTaskKey({ taskId: payload.taskId });
      const signature = `${normalizeEmail(message.senderEmail)}|${message.message}`;

      setMessages((prev) => {
        if (!selectedTask || selectedTask.key !== key) return prev;
        const allowed = filterMessagesForTask([message], selectedTask);
        if (allowed.length === 0) return prev;
        if (prev.some((item) => item.messageId === message.messageId))
          return prev;
        const withoutOptimistic = prev.filter((item) => {
          if (!item.messageId || !String(item.messageId).startsWith("local-")) {
            return true;
          }
          return item.__signature !== signature;
        });
        optimisticRef.current.delete(signature);
        return [...withoutOptimistic, message];
      });

      if (!selectedTask || selectedTask.key !== key || !isOpen) {
        if (filterMessagesForTask([message], selectedTask).length === 0) return;
        setUnreadByTask((prev) => ({
          ...prev,
          [key]: (prev[key] || 0) + 1,
        }));
        const note = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: `${payload.groupId ? "Group" : "Task"} message: ${String(
            message.message || "",
          ).slice(0, 42)}`,
        };
        setNotifications((prev) => [...prev, note]);
        window.setTimeout(() => {
          setNotifications((prev) =>
            prev.filter((item) => item.id !== note.id),
          );
        }, 3600);
      }
    });

    return () => socket.disconnect();
  }, [selectedTask, isOpen, filterMessagesForTask, isSubtaskNotice]);

  const handleSend = async () => {
    const trimmed = messageText.trim();
    if (!selectedTask || !trimmed || !canChat || sending) return;
    setSending(true);
    setError("");
    setAssistantError("");
    const isSingleTask = !selectedTask.groupId;
    const savyMatch = trimmed.match(/@savy\b/i);
    const savyQuestion = isSingleTask
      ? trimmed
      : savyMatch
        ? trimmed.replace(savyMatch[0], "").trim()
        : "";
    const signature = `${normalizeEmail(user.email)}|${trimmed}`;
    const optimisticMessage = {
      messageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderName: user.name || "Member",
      senderEmail: user.email,
      senderRole: user.role,
      message: trimmed,
      createdAt: new Date().toISOString(),
      type: "user",
      __signature: signature,
    };
    optimisticRef.current.set(signature, optimisticMessage.messageId);
    setMessages((prev) => [...prev, optimisticMessage]);
    atBottomRef.current = true;
    scrollToBottom("smooth");

    try {
      const payload = {
        senderName: user.name || "Member",
        senderEmail: user.email,
        senderRole: user.role,
        message: trimmed,
      };

      if (selectedTask.groupId) {
        await axios.post(
          `${API_URL}/group-tasks/${selectedTask.groupId}/chat/messages`,
          payload,
        );
      } else if (!isSingleTask && selectedTask.taskId && selectedTask.ownerEmail) {
        await axios.post(
          `${API_URL}/employees/${selectedTask.ownerEmail}/tasks/${selectedTask.taskId}/chat/messages`,
          payload,
        );
      }

      setMessageText("");
      if (savyQuestion) {
        void handleAssistantRequest({
          question: savyQuestion,
          taskKey: selectedTask.key,
          contextTask: selectedTaskDetails || {},
        });
      }
    } catch (err) {
      setError("Unable to send message. Please retry.");
      setMessages((prev) =>
        prev.filter((item) => item.messageId !== optimisticMessage.messageId),
      );
    } finally {
      setSending(false);
    }
  };

  const handleAssistantRequest = async ({ question, taskKey, contextTask }) => {
    if (!selectedTask || !question || assistantLoading || !canChat) return;
    setAssistantLoading(true);
    setAssistantError("");

    try {
      const normalizedUserEmail = normalizeEmail(user?.email);
      const assignedSteps = Array.isArray(contextTask.groupStepAssignments)
        ? contextTask.groupStepAssignments
            .filter(
              (item) =>
                normalizeEmail(item?.assignedEmail) === normalizedUserEmail,
            )
            .map((item) => item.step)
            .filter(Boolean)
        : Array.isArray(contextTask.explainSteps)
          ? contextTask.explainSteps
          : [];
      const fallbackMember =
        selectedTask?.ownerName || selectedTask?.ownerEmail || user?.name;
      const fallbackMembers = fallbackMember
        ? [
            {
              name: fallbackMember,
              email: selectedTask?.ownerEmail || user?.email,
            },
          ]
        : [];
      const promptPayload = {
        question,
        requester: {
          name: user?.name || "Member",
          email: user?.email,
          role: user?.role || "employee",
        },
        privacy: {
          scope: "current-task-only",
          rules: [
            "Do not mention other employees, tasks, or admin decisions.",
            "Only answer about the current task for the requesting user.",
          ],
        },
        task: {
          title: contextTask.taskTitle,
          description: contextTask.taskDescription,
          assignedSteps,
          steps: Array.isArray(contextTask.explainSteps)
            ? contextTask.explainSteps
            : Array.isArray(contextTask.groupStepAssignments)
              ? contextTask.groupStepAssignments.map((item) => item.step)
              : [],
          assignments: Array.isArray(contextTask.groupStepAssignments)
            ? contextTask.groupStepAssignments
            : [],
          members: Array.isArray(contextTask.groupMembers)
            ? contextTask.groupMembers
            : fallbackMembers,
        },
      };

      const response = await axios.post(
        `${API_URL}/gemini/task-assistant`,
        promptPayload,
      );
      const answer = String(response.data?.answer || "").trim();
      if (!answer) {
        throw new Error("Assistant response unavailable");
      }

      const signature = `assistant@system|${answer}`;
      const assistantMessage = {
        messageId: `local-assistant-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        senderName: "Savy",
        senderEmail: "assistant@system",
        senderRole: "assistant",
        message: answer,
        createdAt: new Date().toISOString(),
        type: "assistant",
        __signature: signature,
      };

      const existing = privateAssistantByTaskRef.current.get(taskKey) || [];
      privateAssistantByTaskRef.current.set(taskKey, [
        ...existing,
        assistantMessage,
      ]);

      if (selectedTask && selectedTask.key === taskKey) {
        setMessages((prev) => [...prev, assistantMessage]);
        atBottomRef.current = true;
        scrollToBottom("smooth");
      }
    } catch (err) {
      setAssistantError("Assistant is unavailable right now. Please retry.");
    } finally {
      setAssistantLoading(false);
    }
  };

  const handleEnableChat = async () => {
    if (!selectedTask || selectedTask.groupId || !selectedTask.taskId) return;
    try {
      await axios.post(
        `${API_URL}/employees/${selectedTask.ownerEmail}/tasks/${selectedTask.taskId}/chat/enable`,
      );
    } catch {
      setError("Unable to enable chat for this task.");
    }
  };

  const handleCloseChat = async () => {
    if (!selectedTask) return;
    try {
      if (selectedTask.groupId) {
        await axios.post(
          `${API_URL}/group-tasks/${selectedTask.groupId}/chat/close`,
        );
      } else if (selectedTask.taskId && selectedTask.ownerEmail) {
        await axios.post(
          `${API_URL}/employees/${selectedTask.ownerEmail}/tasks/${selectedTask.taskId}/chat/close`,
        );
      }
    } catch {
      setError("Unable to close chat for this task.");
    }
  };

  const panelBase = isDark
    ? "bg-[#121212] border-white/10 text-white"
    : "bg-white border-gray-200 text-gray-900";
  const panelMuted = isDark ? "text-white/60" : "text-gray-500";
  const panelAccent = isDark ? "bg-white/10" : "bg-gray-100";

  return (
    <>
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
        {notifications.map((note) => (
          <div
            key={note.id}
            className={`chat-slip rounded-lg px-3 py-2 text-xs shadow-xl ${
              isDark
                ? "bg-black/80 text-white border border-white/15"
                : "bg-white text-gray-900 border border-gray-200"
            }`}
          >
            {note.text}
          </div>
        ))}
        {!isOpen && (
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            className={`relative flex h-12 w-12 items-center justify-center rounded-full border shadow-lg transition-all ${
              isDark
                ? "border-cyan-300/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            aria-label="Open task chat"
          >
            <MessageCircle size={20} />
            {hasUnread && (
              <span className="absolute -right-1 -top-1 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
              </span>
            )}
          </button>
        )}
      </div>

      <div
        className={`fixed bottom-16 right-6 top-16 z-50 flex w-[360px] max-w-[92vw] flex-col rounded-2xl border shadow-2xl transition-transform duration-300 ${
          panelBase
        } ${isOpen ? "translate-x-0 pointer-events-auto" : "translate-x-[120%] pointer-events-none"} overflow-hidden`}
        onWheel={(event) => event.stopPropagation()}
      >
        <div
          className={`flex items-center justify-between border-b px-4 py-3 ${panelAccent}`}
        >
          <div>
            <p className="text-sm font-semibold">Task Chat</p>
            <p className={`text-[11px] ${panelMuted}`}>
              {selectedTask ? selectedTask.title : "Select a task"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className={`rounded-full p-1 ${isDark ? "hover:bg-white/10" : "hover:bg-gray-100"}`}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-3 py-2">
            <select
              value={selectedKey || ""}
              onChange={(event) => setSelectedKey(event.target.value)}
              className={`w-full rounded-lg border px-2 py-1 text-xs ${
                isDark
                  ? "border-white/10 bg-black/40 text-white"
                  : "border-gray-200 bg-white text-gray-800"
              }`}
            >
              {chatTasks.length === 0 && (
                <option value="">No chat-ready tasks</option>
              )}
              {chatTasks.map((task) => (
                <option key={task.key} value={task.key}>
                  {task.title} {task.groupId ? "(Group)" : ""}
                </option>
              ))}
            </select>
            {selectedTask && (
              <div
                className={`mt-2 flex flex-wrap gap-2 text-[11px] ${panelMuted}`}
              >
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${
                    selectedTask.active
                      ? "bg-emerald-500/20 text-emerald-300"
                      : "bg-yellow-500/20 text-yellow-300"
                  }`}
                >
                  <CheckCircle2 size={12} />
                  {selectedTask.active ? "Active" : "Not active"}
                </span>
                {selectedTask.chatClosed && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-1 text-red-300">
                    <Lock size={12} /> Closed
                  </span>
                )}
              </div>
            )}
          </div>

          <div
            className="flex-1 min-h-0 overflow-y-auto px-4 py-3 overscroll-contain"
            ref={scrollRef}
            onScroll={(event) => {
              const target = event.currentTarget;
              const distance =
                target.scrollHeight - target.scrollTop - target.clientHeight;
              atBottomRef.current = distance < 24;
            }}
          >
            {loading && (
              <div className="space-y-3">
                {[1, 2, 3].map((item) => (
                  <div
                    key={item}
                    className={`h-10 rounded-lg ${
                      isDark ? "bg-white/10" : "bg-gray-100"
                    }`}
                  />
                ))}
              </div>
            )}
            {!loading && messages.length === 0 && (
              <p className={`text-xs ${panelMuted}`}>No messages yet.</p>
            )}
            <div className="space-y-3">
              {messages.map((message) => {
                const isSystem = message.type === "system";
                const isAssistant = message.type === "assistant";
                const isAcceptedMessage = isSystem && isAcceptedNotice(message);
                const isOwn =
                  normalizeEmail(message.senderEmail) ===
                    normalizeEmail(user.email) &&
                  !isAssistant &&
                  !isSystem;
                const isAdmin =
                  message.senderRole === "admin" ||
                  normalizeEmail(message.senderEmail) === "admin";
                const bubbleTone = isSystem
                  ? isDark
                    ? "bg-white/10 text-white/80"
                    : "bg-gray-100 text-gray-600"
                  : isAssistant
                    ? isDark
                      ? "bg-purple-500/15 text-purple-100"
                      : "bg-purple-50 text-purple-800"
                    : isOwn
                      ? isDark
                        ? "bg-cyan-500/30 text-white"
                        : "bg-cyan-100 text-cyan-900"
                      : isAdmin
                        ? isDark
                          ? "bg-amber-500/15 text-amber-100"
                          : "bg-amber-50 text-amber-900"
                        : isDark
                          ? "bg-white/10 text-white"
                          : "bg-slate-100 text-gray-800";
                return (
                  <div
                    key={message.messageId || message.createdAt}
                    className={`flex ${
                      isSystem
                        ? "justify-center"
                        : isOwn
                          ? "justify-end"
                          : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${bubbleTone} ${
                        isAcceptedMessage ? "text-[10px] opacity-70" : ""
                      }`}
                    >
                      {!isAcceptedMessage && (
                        <div className="flex items-center justify-between text-[10px] opacity-70">
                          <span>
                            {isSystem
                              ? "System"
                              : isAssistant
                                ? "Savy"
                                : message.senderName || "Member"}
                          </span>
                          <span>{formatTimestamp(message.createdAt)}</span>
                        </div>
                      )}
                      <p
                        className={
                          isAcceptedMessage
                            ? "leading-relaxed"
                            : "mt-1 leading-relaxed"
                        }
                      >
                        {isAcceptedMessage &&
                        !/task accepted by/i.test(String(message.message || ""))
                          ? (() => {
                              const emailMatch = String(
                                message.message || "",
                              ).match(/[\w.+-]+@[\w.-]+/);
                              const name =
                                message.senderName &&
                                message.senderName !== "System"
                                  ? message.senderName
                                  : emailMatch?.[0];
                              return `Task accepted by ${name || "member"}`;
                            })()
                          : message.message}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`border-t px-3 py-2 ${panelAccent}`}>
            {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}
            {assistantError && (
              <p className="mb-2 text-[11px] text-red-400">{assistantError}</p>
            )}
            {!canChat && selectedTask && (
              <p className={`mb-2 text-[11px] ${panelMuted}`}>
                Chat is read-only until enabled or re-opened by admin.
              </p>
            )}
            {selectedTask &&
              isAdmin &&
              selectedTask.active &&
              !selectedTask.chatEnabled &&
              !selectedTask.groupId && (
                <button
                  type="button"
                  onClick={handleEnableChat}
                  className={`mb-2 w-full rounded-lg border px-3 py-1 text-[11px] font-semibold ${
                    isDark
                      ? "border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/10"
                      : "border-slate-200 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Enable chat for this task
                </button>
              )}
            {selectedTask &&
              isAdmin &&
              selectedTask.active &&
              !selectedTask.chatClosed && (
                <button
                  type="button"
                  onClick={handleCloseChat}
                  className={`mb-2 w-full rounded-lg border px-3 py-1 text-[11px] font-semibold ${
                    isDark
                      ? "border-red-400/40 text-red-200 hover:bg-red-500/10"
                      : "border-red-200 text-red-600 hover:bg-red-50"
                  }`}
                >
                  Close chat
                </button>
              )}
            <div className="flex items-center gap-2">
              <textarea
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
                rows={1}
                disabled={!canChat || sending}
                placeholder={
                  canChat
                    ? "Write a message... Use @savy for AI help"
                    : "Chat is closed or not enabled"
                }
                className={`flex-1 resize-none rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                  isDark
                    ? "border-white/10 bg-black/40 text-white"
                    : "border-gray-200 bg-white text-gray-800"
                }`}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!canChat || sending}
                className={`flex h-9 w-9 items-center justify-center rounded-full border ${
                  isDark
                    ? "border-white/10 bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30"
                    : "border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default TaskChatDock;
