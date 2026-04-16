import { cookies } from "next/headers";
import { BikeForm } from "../../../../components/bike-form";
import { loadBikeWorkspace } from "../../../../lib/fleet-api";

export default async function NewBikePage() {
  const cookieHeader = (await cookies()).toString();
  const { data, apiBase, error } = await loadBikeWorkspace(cookieHeader);

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Fleet API</div>
        <h3>Форма велосипеда пока недоступна</h3>
        <p className="route-card-note">
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `crm-api` и маршруты `/bikes/workspace`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return <BikeForm mode="create" workspace={data} />;
}
