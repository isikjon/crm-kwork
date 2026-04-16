import { cookies } from "next/headers";
import { loadUsersWorkspace } from "../lib/users-api";
import { UsersWorkspaceClient } from "./users-workspace-client";

export async function UsersLivePanel() {
  const { data, apiBase, error } = await loadUsersWorkspace(cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Users API</div>
        <h3>Роли и права пока недоступны</h3>
        <p className="route-card-note">
          Этот раздел теперь требует рабочую session-cookie и permission enforcement.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверьте, что у текущего пользователя есть право `users.view`.</li>
          <li>Если это первый вход, сначала выполните bootstrap/login.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return <UsersWorkspaceClient workspace={data} />;
}
