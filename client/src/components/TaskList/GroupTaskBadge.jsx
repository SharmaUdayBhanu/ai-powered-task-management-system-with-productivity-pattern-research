import React from "react";
import { Users } from "lucide-react";

const GroupTaskBadge = ({ task }) => {
  if (!task?.groupTask) return null;
  const total = Array.isArray(task.groupMembers) ? task.groupMembers.length : 0;
  const accepted = Array.isArray(task.groupAcceptedEmails)
    ? task.groupAcceptedEmails.length
    : (task.groupMembers || []).filter((member) => member.accepted).length;

  return (
    <span
      title="Group task acceptance progress"
      className="inline-flex items-center gap-1 rounded-full border border-white/25 bg-white/15 px-2 py-1 text-[10px] font-semibold text-white"
    >
      <Users size={12} />
      Group Task - {accepted}/{total || 1} Accepted
    </span>
  );
};

export default GroupTaskBadge;
