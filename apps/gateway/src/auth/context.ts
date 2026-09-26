export type Role = "owner" | "admin" | "member";

export type AuthCapabilities = {
  canManageUsers: boolean;
  canManageSharedMcps: boolean;
  canInvite: boolean;
};

export type AuthContext = {
  userId: string;
  username: string;
  role: Role;
};

export function capabilitiesForRole(role: Role): AuthCapabilities {
  const elevated = role === "owner" || role === "admin";
  return {
    canManageUsers: elevated,
    canManageSharedMcps: elevated,
    canInvite: elevated,
  };
}

export function isElevatedRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function parseRole(raw: string | null | undefined): Role {
  if (raw === "owner" || raw === "admin" || raw === "member") return raw;
  return "member";
}
