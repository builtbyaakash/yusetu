import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { authApi, teamApi } from "../api";
import type { CreateInviteResponse, Role, TeamInvite } from "../api/types";
import { ConfirmDialog, type ConfirmIntent } from "../components/ConfirmDialog";
import { Pagination, useClientPage } from "../components/Pagination";
import { EmptyState, TableSkeleton } from "../components/Skeleton";

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
  const [confirm, setConfirm] = useState<ConfirmIntent | null>(null);

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

  const invites = useMemo(
    () => invitesQuery.data ?? [],
    [invitesQuery.data],
  );
  const members = useMemo(
    () => membersQuery.data ?? [],
    [membersQuery.data],
  );
  const {
    page: invitePage,
    setPage: setInvitePage,
    pageItems: pagedInvites,
    total: inviteTotal,
  } = useClientPage(invites);
  const {
    page: memberPage,
    setPage: setMemberPage,
    pageItems: pagedMembers,
    total: memberTotal,
  } = useClientPage(members);

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
      setConfirm(null);
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
      setConfirm(null);
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
        <section className="page-section">
          <h2>Create invite</h2>
          <p className="hint">
            Share the link once. Each invite is single-use and expires in seven
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
              <p>Copy this join URL and send it to your teammate.</p>
              <div className="copy-row">
                <code className="key-reveal">
                  {window.location.origin}
                  {createdInvite.joinPath}
                </code>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void copyJoinLink()}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {me?.capabilities.canInvite ? (
        <section className="page-section page-section--wide">
          <h2>Invites</h2>
          {invitesQuery.isLoading ? <TableSkeleton rows={4} cols={5} /> : null}
          {invitesQuery.error ? (
            <div className="alert alert-error">
              {invitesQuery.error instanceof ApiError
                ? invitesQuery.error.message
                : "Failed to load invites."}
            </div>
          ) : null}
          {!invitesQuery.isLoading &&
          invitesQuery.data &&
          invitesQuery.data.length === 0 ? (
            <EmptyState
              title="No invites yet"
              body="Create an invite link above. Each link works once and expires in seven days."
            />
          ) : null}
          {invites.length > 0 ? (
            <>
            <div className="table-wrap">
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
                  {pagedInvites.map((invite) => {
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
                              onClick={() =>
                                setConfirm({
                                  title: "Revoke invite",
                                  message: "Revoke this invite link?",
                                  confirmLabel: "Revoke",
                                  danger: true,
                                  onConfirm: () =>
                                    revokeMutation.mutate(invite.id),
                                })
                              }
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
            <Pagination
              total={inviteTotal}
              page={invitePage}
              onPageChange={setInvitePage}
            />
            </>
          ) : null}
        </section>
      ) : null}

      {me?.capabilities.canManageUsers ? (
        <section className="page-section page-section--wide">
          <h2>Members</h2>
          {membersQuery.isLoading ? <TableSkeleton rows={4} cols={4} /> : null}
          {membersQuery.error ? (
            <div className="alert alert-error">
              {membersQuery.error instanceof ApiError
                ? membersQuery.error.message
                : "Failed to load members."}
            </div>
          ) : null}
          {!membersQuery.isLoading &&
          membersQuery.data &&
          members.length === 0 ? (
            <EmptyState
              title="No members yet"
              body="People show up here after they accept an invite."
            />
          ) : null}
          {members.length > 0 ? (
            <>
            <div className="table-wrap">
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
                  {pagedMembers.map((member) => {
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
                            <div className="hint hint-danger">
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
                            onClick={() =>
                              setConfirm({
                                title: "Remove member",
                                message: `Remove “${member.username}” from this team?`,
                                confirmLabel: "Remove",
                                danger: true,
                                onConfirm: () =>
                                  removeMutation.mutate(member.id),
                              })
                            }
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
            <Pagination
              total={memberTotal}
              page={memberPage}
              onPageChange={setMemberPage}
            />
            </>
          ) : null}
        </section>
      ) : null}

      <ConfirmDialog
        intent={confirm}
        onDismiss={() => setConfirm(null)}
        busy={revokeMutation.isPending || removeMutation.isPending}
      />
    </div>
  );
}
