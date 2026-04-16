"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { UsersWorkspaceData } from "../lib/users-api";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "еще не входил";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

export function UsersWorkspaceClient(props: {
  workspace: UsersWorkspaceData;
}) {
  const router = useRouter();
  const canManageUsers = useHasPermission("users.manage_users");
  const canAssignRoles = useHasPermission("users.assign_roles");
  const canManageRoles = useHasPermission("users.manage_roles");
  const [isPending, startTransition] = useTransition();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [branchId, setBranchId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});

  const roleOptions = useMemo(
    () => props.workspace.roles.rows.map((role) => ({
      id: role.id,
      name: role.name,
      isSystem: role.isSystem
    })),
    [props.workspace.roles.rows]
  );

  function setRoleDraft(userId: string, roleId: string) {
    setRoleDrafts((current) => ({
      ...current,
      [userId]: roleId
    }));
  }

  function createUser() {
    setError(null);
    setStatus(null);

    if (!fullName.trim() || !email.trim() || !password.trim()) {
      setError("Заполните имя, email и пароль.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/users`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            fullName: fullName.trim(),
            email: email.trim().toLowerCase(),
            password: password.trim(),
            branchId: branchId || undefined
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setFullName("");
        setEmail("");
        setPassword("");
        setBranchId("");
        setStatus(`Сотрудник ${payload?.user?.fullName ?? ""} добавлен.`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось создать сотрудника.");
      }
    });
  }

  function assignRole(userId: string) {
    const roleId = roleDrafts[userId];
    if (!roleId) {
      setError("Сначала выберите роль.");
      return;
    }

    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/users/${userId}/roles`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            roleId
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setRoleDraft(userId, "");
        setStatus("Роль назначена.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось назначить роль.");
      }
    });
  }

  function unassignRole(userId: string, roleId: string) {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/users/${userId}/roles/${roleId}?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
          method: "DELETE",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Роль снята.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось снять роль.");
      }
    });
  }

  return (
    <div className="section-stack">
      <section className="surface-card">
        <div className="surface-kicker">Live data</div>
        <h3>Роли, сотрудники и first-pass доступы</h3>
        <p className="route-card-note">
          Tenant: {props.workspace.tenant.name} · сотрудников: {props.workspace.users.total} · ролей: {props.workspace.roles.total}.
        </p>
        {props.workspace.users.branchScoped ? (
          <p className="route-card-note">Список сотрудников отфильтрован по вашей точке, потому что право `users.view` выдано как branch-scoped.</p>
        ) : null}
      </section>

      <section className="content-grid">
        <article className="surface-card">
          <div className="surface-kicker">Матрица прав</div>
          <h3>Permission catalog</h3>
          <div className="timeline-list">
            {props.workspace.permissions.rows.map((group) => (
              <div className="timeline-item" key={group.category}>
                <div>{group.category}</div>
                <div className="timeline-meta">
                  {group.permissions.map((permission) => permission.code).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="surface-card">
          <div className="surface-kicker">Роли</div>
          <h3>Текущие tenant-роли</h3>
          <div className="record-grid">
            {props.workspace.roles.rows.map((role) => (
              <article className="record-card" key={role.id}>
                <div className="status-line">
                  <div className="record-title">{role.name}</div>
                  <span>{role.isSystem ? "SYSTEM" : "CUSTOM"}</span>
                </div>
                <div className="record-meta">
                  {role.description ?? "без описания"} · users: {role.usersCount}
                </div>
                <div className="record-tags">
                  {role.permissions.length > 0 ? role.permissions.map((permission) => (
                    <span className="tag-chip" key={permission.id}>
                      {permission.permission.code}{permission.branchScoped ? " · branch" : ""}
                    </span>
                  )) : <span className="tag-chip">прав пока нет</span>}
                </div>
              </article>
            ))}
          </div>
          {!canManageRoles ? <p className="route-card-note">Изменение ролей доступно только пользователю с правом `users.manage_roles`.</p> : null}
        </article>
      </section>

      <section className="surface-card">
        <div className="surface-kicker">Сотрудники</div>
        <div className="orders-create-title-row">
          <h3>Минимальный assignment flow</h3>
          <span className="orders-expand-muted">Без большого HR-модуля: только безопасное добавление и назначение ролей</span>
        </div>

        <div className="action-field-grid">
          <label className="action-field">
            <span>ФИО</span>
            <input className="action-input" value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </label>

          <label className="action-field">
            <span>Email</span>
            <input className="action-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>

          <label className="action-field">
            <span>Пароль</span>
            <input className="action-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>

          <label className="action-field">
            <span>Точка</span>
            <select className="action-input" value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">Без точки</option>
              {props.workspace.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="record-actions">
          <button className="action-button" disabled={!canManageUsers || isPending} type="button" onClick={createUser}>
            {isPending ? "Сохраняю..." : "Добавить сотрудника"}
          </button>
        </div>

        {!canManageUsers ? <p className="route-card-note">Недостаточно прав для добавления сотрудников.</p> : null}
        {error ? <p className="action-status is-error">{error}</p> : null}
        {status ? <p className="action-status is-success">{status}</p> : null}

        <div className="record-grid">
          {props.workspace.users.rows.map((user) => {
            const assignedRoleIds = new Set(user.roles.map((role) => role.id));
            const assignableRoles = roleOptions.filter((role) => !assignedRoleIds.has(role.id));

            return (
              <article className="record-card" key={user.id}>
                <div className="status-line">
                  <div className="record-title">{user.fullName}</div>
                  <span>{user.status}</span>
                </div>
                <div className="record-meta">
                  {user.email} · {user.branch?.name ?? "без точки"} · вход: {formatDateTime(user.lastLoginAt)}
                </div>

                <div className="record-tags">
                  {user.isTenantOwner ? <span className="tag-chip">owner</span> : null}
                  {user.isSupportUser ? <span className="tag-chip">support</span> : null}
                  {user.roles.length > 0 ? user.roles.map((role) => (
                    <span className="tag-chip" key={role.id}>
                      {role.name}{role.isSystem ? " · system" : ""}
                    </span>
                  )) : <span className="tag-chip">ролей пока нет</span>}
                </div>

                <div className="action-field-grid">
                  <label className="action-field action-field-wide">
                    <span>Назначить роль</span>
                    <select
                      className="action-input"
                      value={roleDrafts[user.id] ?? ""}
                      onChange={(event) => setRoleDraft(user.id, event.target.value)}
                    >
                      <option value="">Выберите роль</option>
                      {assignableRoles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="record-actions">
                  <button
                    className="action-button action-button-secondary"
                    disabled={!canAssignRoles || isPending || !roleDrafts[user.id]}
                    type="button"
                    onClick={() => assignRole(user.id)}
                  >
                    Назначить роль
                  </button>
                </div>

                {user.roles.length > 0 ? (
                  <div className="timeline-list">
                    {user.roles.map((role) => (
                      <div className="timeline-item" key={`${user.id}-${role.id}`}>
                        <div>{role.name}</div>
                        <div className="timeline-meta">
                          <button
                            className="detail-link"
                            disabled={!canAssignRoles || isPending}
                            type="button"
                            onClick={() => unassignRole(user.id, role.id)}
                          >
                            Снять роль
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>

        {!canAssignRoles ? <p className="route-card-note">Недостаточно прав для назначения и снятия ролей.</p> : null}
      </section>
    </div>
  );
}
