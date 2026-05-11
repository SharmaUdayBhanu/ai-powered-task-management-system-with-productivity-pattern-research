import React, { useMemo, useState } from "react";

const getEmployeeName = (employee = {}) =>
  [employee.firstName, employee.lastName].filter(Boolean).join(" ") ||
  "Unnamed employee";

const matchesEmployee = (employee, query) => {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return false;
  const name = getEmployeeName(employee).toLowerCase();
  const email = String(employee.email || "").toLowerCase();
  return name.includes(normalized) || email.includes(normalized);
};

const inputClass = (theme) =>
  theme === "dark"
    ? "border p-2 rounded w-full bg-[#222] text-white"
    : "border p-2 rounded w-full bg-white text-black";

const EmployeeAutocomplete = ({
  employees = [],
  value = "",
  onChange,
  onSelect,
  placeholder = "Employee name or email",
  theme = "dark",
  required = false,
  className = "",
  inputName,
  inputType = "text",
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const query = String(value || "");
  const suggestions = useMemo(
    () => employees.filter((employee) => matchesEmployee(employee, query)).slice(0, 8),
    [employees, query],
  );
  const showSuggestions = isFocused && query.trim().length > 0;

  const handleSelect = (employee) => {
    onChange?.(employee.email || "");
    onSelect?.(employee);
    setIsFocused(false);
  };

  return (
    <div className={`relative ${className}`}>
      <input
        name={inputName}
        type={inputType}
        value={value}
        onChange={(event) => {
          onChange?.(event.target.value);
          setIsFocused(true);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => window.setTimeout(() => setIsFocused(false), 120)}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        className={inputClass(theme)}
      />
      {showSuggestions && (
        <div
          className={`absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-y-auto rounded-lg border shadow-xl ${
            theme === "dark"
              ? "border-white/10 bg-[#181818] text-white"
              : "border-gray-200 bg-white text-gray-900"
          }`}
        >
          {suggestions.length > 0 ? (
            suggestions.map((employee) => (
              <button
                key={employee._id || employee.email}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(employee)}
                className={`block w-full px-3 py-2 text-left text-xs transition-colors ${
                  theme === "dark" ? "hover:bg-white/10" : "hover:bg-gray-50"
                }`}
              >
                <span className="font-semibold">{getEmployeeName(employee)}</span>
                <span className="opacity-70"> - {employee.email}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-xs opacity-70">
              No matching employee found
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const EmployeeMultiSelect = ({
  employees = [],
  selectedEmails = [],
  onChange,
  theme = "dark",
}) => {
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selectedEmails.map((email) => email.toLowerCase()));
  const selectedEmployees = selectedEmails.map((email) => {
    const employee = employees.find(
      (item) => String(item.email || "").toLowerCase() === email.toLowerCase(),
    );
    return employee || { email };
  });

  const addEmployee = (employee) => {
    const email = String(employee.email || "").trim().toLowerCase();
    if (!email || selectedSet.has(email)) return;
    onChange?.([...selectedEmails, email]);
    setQuery("");
  };

  const removeEmail = (email) => {
    onChange?.(selectedEmails.filter((item) => item !== email));
  };

  return (
    <div
      className={`rounded border p-2 ${
        theme === "dark" ? "border-white/10 bg-[#222]" : "border-gray-200 bg-white"
      }`}
    >
      <div className="mb-2 flex flex-wrap gap-1.5">
        {selectedEmployees.map((employee) => (
          <span
            key={employee.email}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
              theme === "dark" ? "bg-cyan-500/20 text-cyan-200" : "bg-cyan-50 text-cyan-800"
            }`}
          >
            {employee.firstName ? `${getEmployeeName(employee)} - ${employee.email}` : employee.email}
            <button
              type="button"
              onClick={() => removeEmail(employee.email)}
              className="text-sm leading-none opacity-80 hover:opacity-100"
              aria-label={`Remove ${employee.email}`}
            >
              x
            </button>
          </span>
        ))}
      </div>
      <EmployeeAutocomplete
        employees={employees.filter(
          (employee) =>
            !selectedSet.has(String(employee.email || "").toLowerCase()),
        )}
        value={query}
        onChange={setQuery}
        onSelect={addEmployee}
        placeholder="Type name or email to add"
        theme={theme}
      />
    </div>
  );
};

export const isKnownEmployeeEmail = (employees = [], email = "") =>
  employees.some(
    (employee) =>
      String(employee.email || "").toLowerCase() ===
      String(email || "").trim().toLowerCase(),
  );

export default EmployeeAutocomplete;
