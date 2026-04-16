import { loadTariffsWorkspace } from "../lib/tariffs-api";
import { TariffsEditor } from "./tariffs-editor";

export async function TariffsLivePanel() {
  const { data, apiBase, error } = await loadTariffsWorkspace();

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Tariffs API</div>
        <h3>Тарифные группы пока недоступны</h3>
        <p className="route-card-note">
          Здесь будут создаваться группы тарифов `1 / 7 / 30+` с общими штрафами и привязкой к велосипедам. Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `crm-api` и endpoint `/api/v1/tariffs`.</li>
          <li>После изменения Prisma-схемы перезапусти `crm-api`.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return (
    <div className="section-stack">
      <section className="surface-card">
        <div className="surface-kicker">Тарифы</div>
        <h3>Группы и закрепление за велосипедами</h3>
        <div className="record-tags">
          <span className="tag-chip">групп: {data.summary.groupsCount}</span>
          <span className="tag-chip">аренда: {data.summary.rentalGroupsCount}</span>
          <span className="tag-chip">выкуп: {data.summary.buyoutGroupsCount}</span>
          <span className="tag-chip">велосипедов: {data.summary.bikesCount}</span>
        </div>
      </section>

      <TariffsEditor bikes={data.bikes} rows={data.rows} />
    </div>
  );
}
