import { cookies } from "next/headers";
import { OrderCreateForm } from "../../../../components/order-create-form";
import { loadOrderCreateWorkspace } from "../../../../lib/order-create-api";

export default async function OrderCreatePage() {
  const { data, apiBase, error } = await loadOrderCreateWorkspace(cookies().toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Новый заказ</div>
        <h3>Форма оформления пока недоступна</h3>
        <p className="route-card-note">
          Проверь `crm-api` и доступность списков. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `http://localhost:4200/api/v1/system/health`.</li>
          <li>Убедись, что импорт уже создал клиентов и свободные велосипеды.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return <OrderCreateForm workspace={data} />;
}
