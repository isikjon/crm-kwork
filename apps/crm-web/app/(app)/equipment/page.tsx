import { EquipmentCatalogPanel } from "../../../components/equipment-catalog-panel";
import { loadEquipmentCatalog } from "../../../lib/equipment-api";

export default async function EquipmentPage() {
  const { data, apiBase, error } = await loadEquipmentCatalog();

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Equipment API</div>
        <h3>Справочник комплектов пока недоступен</h3>
        <p className="route-card-note">
          Проверь `crm-api`, Prisma sync и доступность API. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `http://localhost:4200/api/v1/system/health`.</li>
          <li>Убедись, что схема БД уже обновлена.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return <EquipmentCatalogPanel catalog={data} />;
}
