import { cookies } from "next/headers";
import { loadDocumentsWorkspace } from "../lib/documents-api";
import { DocumentsWorkspaceClient } from "./documents-workspace-client";

export async function DocumentsLivePanel() {
  const { data, apiBase, error } = await loadDocumentsWorkspace(cookies().toString());
  const publicApiBase = (process.env.NEXT_PUBLIC_CRM_API_BASE ?? apiBase).replace(/\/api\/v1$/, "");

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Документы</div>
        <h3>Раздел документов пока недоступен</h3>
        <p className="route-card-note">
          CRM не смогла загрузить шаблоны, коды и реестр документов для текущего tenant.
        </p>
        <ul className="surface-list">
          <li>Проверьте API документов и file storage.</li>
          <li>Убедитесь, что tenant определен корректно.</li>
          <li>Ошибка: {error ?? "неизвестная ошибка"}.</li>
        </ul>
      </section>
    );
  }

  return <DocumentsWorkspaceClient publicApiBase={publicApiBase} workspace={data} />;
}
