import { NavLink } from "react-router-dom";
import type { AuthMeResponse } from "../api/types";
import { ThemeToggle } from "../lib/theme";
import { UserAvatar } from "./UserAvatar";

const baseLinks = [
  { to: "/mcps", label: "MCPs" },
  { to: "/tools", label: "Tools" },
  { to: "/playground", label: "Playground" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "Settings" },
] as const;

type LayoutProps = {
  user: AuthMeResponse;
  onLogout: () => void;
  loggingOut?: boolean;
  children: React.ReactNode;
};

export function Layout({ user, onLogout, loggingOut, children }: LayoutProps) {
  const showTeam =
    user.capabilities.canInvite || user.capabilities.canManageUsers;
  const links = showTeam
    ? [
        ...baseLinks.slice(0, 4),
        { to: "/team" as const, label: "Team" },
        ...baseLinks.slice(4),
      ]
    : [...baseLinks];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-lockup">
            <img
              className="brand-logo"
              src="/yusetu-mark.png"
              alt=""
            />
            <div className="brand-text">
              <span className="brand-name">Yūsetu</span>
              <span className="brand-tag">One Gateway. Every MCP.</span>
            </div>
          </div>
        </div>
        <nav className="nav-links">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                isActive ? "nav-link active" : "nav-link"
              }
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <UserAvatar username={user.username} />
            <span className="user-chip-name">{user.username}</span>
          </div>
          <div className="sidebar-footer-actions">
            <ThemeToggle />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onLogout}
              disabled={loggingOut}
            >
              {loggingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
