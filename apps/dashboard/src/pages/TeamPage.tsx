import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi, teamApi } from "../api";
import type { CreateInviteResponse, Role, TeamInvite } from "../api/types";

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function inviteStatus(invite: TeamInvite): string {
  if (invite.usedAt) return "Used";
  if (new Date(invite.expiresAt).getTime() < Date.now()) return "Expired";
  return "Pending";
}

export function TeamPage() {
  const queryClient = useQueryClient();
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [createdInvite, setCreatedInvite] = useState<CreateInviteResponse | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => authApi.me(),
  });

  const invitesQuery = useQuery({
    queryKey: ["team", "invites"],
    queryFn: () => teamApi.listInvites(),
    enabled: Boolean(meQuery.data?.capabilities.canInvite),
  });

  const membersQuery = useQuery({
    queryKey: ["team", "members"],
    queryFn: () => teamApi.listMembers(),
    enabled: Boolean(meQuery.data?.capabilities.canManageUsers),
  });

  const createInviteMutation = useMutation({
    mutationFn: () => teamApi.createInvite({ role: inviteRole }),
    onSuccess: (data) => {
      setCreatedInvite(data);
      void queryClient.invalidateQueries({ queryKey: ["team", "invites"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => teamApi.revokeInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["team", "invites"] });
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      teamApi.patchMemberRole(userId, { role }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["team", "members"] });
      void queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => teamApi.removeMember(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["team", "members"] });
    },
  });

  const me = meQuery.data;
  if (meQuery.isSuccess && me) {
    const elevated =
      me.capabilities.canInvite || me.capabilities.canManageUsers;
    if (!elevated) {
      return <Navigate to="/mcps" replace />;
    }
  }

  async function copyJoinLink() {
    if (!createdInvite) return;
    const url = `${window.location.origin}${createdInvite.joinPath}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <p>Invite teammates and manage roles on this instance.</p>
        </div>
      </div>

      {me?.capabilities.canInvite ? (
        <section className="stack" style={{ maxWidth: 720, marginBottom: "2rem" }}>
          <h2>Create invite</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Share the link once — each invite is single-use and expires in seven
            days.
          </p>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              createInviteMutation.mutate();
            }}
          >
            {createInviteMutation.error ? (
              <div className="alert alert-error">
                {createInviteMutation.error instanceof ApiError
                  ? createInviteMutation.error.message
                  : "Failed to create invite."}
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="invite-role">Role for new user</label>
              <select
                id="invite-role"
                className="select"
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as "admin" | "member")
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={createInviteMutation.isPending}
            >
              {createInviteMutation.isPending ? "Creating…" : "Create invite link"}
            </button>
          </form>

          {createdInvite ? (
            <div className="alert alert-success">
              <p style={{ marginBottom: "0.5rem", color: "inherit" }}>
                Copy this join URL and send it to your teammate.
              </p>
              <code className="key-reveal">
                {window.location.origin}
                {createdInvite.joinPath}
              </code>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: "0.75rem" }}
                onClick={() => void copyJoinLink()}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {me?.capabilities.canInvite ? (
        <section style={{ marginBottom: "2rem" }}>
          <h2>Invites</h2>
          {invitesQuery.isLoading ? (
            <div className="empty">Loading invites…</div>
          ) : null}
          {invitesQuery.error ? (
            <div className="alert alert-error">
              {invitesQuery.error instanceof ApiError
                ? invitesQuery.error.message
                : "Failed to load invites."}
            </div>
          ) : null}
          {invitesQuery.data && invitesQuery.data.length === 0 ? (
            <div className="empty">No invites yet.</div>
          ) : null}
          {invitesQuery.data && invitesQuery.data.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Created</th>
                    <th className="col-actions" />
                  </tr>
                </thead>
                <tbody>
                  {invitesQuery.data.map((invite) => {
                    const status = inviteStatus(invite);
                    const canRevoke = status === "Pending";
                    return (
                      <tr key={invite.id}>
                        <td>{invite.role}</td>
                        <td>
                          <span
                            className={`badge ${
                              status === "Pending"
                                ? "badge-warning"
                                : "badge-muted"
                            }`}
                          >
                            {status}
                          </span>
                        </td>
                        <td>{formatDate(invite.expiresAt)}</td>
                        <td>{formatDate(invite.createdAt)}</td>
                        <td className="col-actions">
                          {canRevoke ? (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={revokeMutation.isPending}
                              onClick={() => {
                                if (
                                  window.confirm("Revoke this invite link?")
                                ) {
                                  revokeMutation.mutate(invite.id);
                                }
                              }}
                            >
                              Revoke
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {me?.capabilities.canManageUsers ? (
        <section>
          <h2>Members</h2>
          {membersQuery.isLoading ? (
            <div className="empty">Loading members…</div>
          ) : null}
          {membersQuery.error ? (
            <div className="alert alert-error">
              {membersQuery.error instanceof ApiError
                ? membersQuery.error.message
                : "Failed to load members."}
            </div>
          ) : null}
          {membersQuery.data && membersQuery.data.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Last login</th>
                    <th className="col-actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {membersQuery.data.map((member) => {
                    const isSelf = member.id === me?.id;
                    return (
                      <tr key={member.id}>
                        <td className="cell-name">
                          {member.username}
                          {isSelf ? (
                            <span className="badge badge-muted"> you</span>
                          ) : null}
                        </td>
                        <td>
                          <select
                            className="select"
                            value={member.role}
                            disabled={
                              isSelf || roleMutation.isPending
                            }
                            onChange={(e) =>
                              roleMutation.mutate({
                                userId: member.id,
                                role: e.target.value as Role,
                              })
                            }
                          >
                            <option value="owner">Owner</option>
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                          </select>
                          {roleMutation.error &&
                          roleMutation.variables?.userId === member.id ? (
                            <div className="hint" style={{ color: "var(--danger)" }}>
                              {roleMutation.error instanceof ApiError
                                ? roleMutation.error.message
                                : "Update failed."}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {member.lastLoginAt
                            ? formatDate(member.lastLoginAt)
                            : "—"}
                        </td>
                        <td className="col-actions">
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            disabled={isSelf || removeMutation.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove “${member.username}” from this team?`,
                                )
                              ) {
                                removeMutation.mutate(member.id);
                              }
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
