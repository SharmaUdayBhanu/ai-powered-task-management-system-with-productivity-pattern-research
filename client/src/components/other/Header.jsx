import { useState } from "react";

const Header = ({ data, theme, showSectionNav = true }) => {
  const username = data ? data.firstName || data.name || "User" : "Admin";
  const [activeItem, setActiveItem] = useState(data ? "overview" : "workspace");

  const navItems = data
    ? [
        { id: "overview", label: "Overview", target: "overview" },
        { id: "insights", label: "Insights", target: "insights" },
        { id: "tasks", label: "Tasks", target: "tasklist" },
      ]
    : [
        { id: "workspace", label: "Workspace", target: "admin-workspace" },
        { id: "team", label: "Team", target: "team-overview" },
        { id: "rankings", label: "Rankings", target: "rankings" },
      ];

  const logOutuser = () => {
    localStorage.removeItem("loggedInUser");
    window.location.reload();
  };

  const handleNavClick = (item) => {
    setActiveItem(item.id);
    document
      .getElementById(item.target)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <header
      className={`sticky top-3 z-40 flex flex-col gap-4 rounded-xl border p-4 shadow-xl backdrop-blur-xl transition-all duration-300 ease-in-out sm:flex-row sm:items-center sm:justify-between ${
        theme === "dark"
          ? "border-white/10 bg-[#111]/85 text-white shadow-black/20"
          : "border-gray-200 bg-white/85 text-gray-950 shadow-gray-200/80"
      }`}
    >
      <div>
        <p
          className={`text-xs font-semibold uppercase tracking-normal ${
            theme === "dark" ? "text-gray-400" : "text-gray-500"
          }`}
        >
          Dashboard
        </p>
        <h1 className="text-2xl font-bold leading-tight sm:text-3xl">
          Hello, <span>{username}</span>
        </h1>
      </div>

      {showSectionNav && (
        <nav
          className={`flex w-full items-center gap-1 rounded-xl p-1 sm:w-auto ${
            theme === "dark" ? "bg-white/10" : "bg-gray-100"
          }`}
          aria-label="Dashboard sections"
        >
          {navItems.map((item) => {
            const active = activeItem === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item)}
                className={`relative flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-all duration-300 ease-in-out hover:scale-105 sm:flex-none ${
                  active
                    ? theme === "dark"
                      ? "bg-white text-gray-950 shadow-md"
                      : "bg-gray-950 text-white shadow-md"
                    : theme === "dark"
                      ? "text-gray-300 hover:text-white"
                      : "text-gray-600 hover:text-gray-950"
                }`}
              >
                {item.label}
                <span
                  className={`absolute inset-x-3 -bottom-1 h-0.5 rounded-full transition-all duration-300 ease-in-out ${
                    active
                      ? theme === "dark"
                        ? "bg-cyan-300 opacity-100"
                        : "bg-gray-950 opacity-100"
                      : "scale-x-0 opacity-0"
                  }`}
                />
              </button>
            );
          })}
        </nav>
      )}

      <button
        onClick={logOutuser}
        className="w-full rounded-lg bg-red-500 px-4 py-2.5 font-bold text-white shadow-md shadow-red-900/20 transition-all duration-300 ease-in-out hover:scale-105 hover:bg-red-400 hover:shadow-lg active:scale-95 sm:w-auto"
      >
        Log Out
      </button>
    </header>
  );
};

export default Header;
