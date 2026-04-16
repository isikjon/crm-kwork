import { cookies } from "next/headers";
import { BankCreateForm } from "./bank-create-form";
import { loadBanksList } from "../lib/banks-api";

function getInstructionLabel(instructionType: string) {
  return instructionType === "QR" ? "QR" : "Реквизиты";
}

export async function BanksLivePanel() {
  const { data, apiBase, error } = await loadBanksList((await cookies()).toString());

  if (!data) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Banks API</div>
        <h3>Справочник банков пока недоступен</h3>
        <p className="route-card-note">
          Здесь выбираем, что уходит клиенту после оформления: QR или реквизиты.
          Ожидаемый API base: <strong>{apiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Поднять `crm-api` и PostgreSQL.</li>
          <li>Добавить банки и bank assets в новый контур.</li>
          <li>Ошибка: {error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  return (
    <section className="section-stack">
      <BankCreateForm />

      <section className="surface-card">
        <div className="surface-kicker">Live data</div>
        <h3>Банки и отправка клиенту</h3>
        <p className="route-card-note">
          Tenant: {data.tenant.name} · банков: {data.total}
        </p>

        {data.rows.length === 0 ? (
          <ul className="surface-list">
            <li>Банки пока не заведены в новой CRM.</li>
            <li>Здесь будут храниться QR-картинки и текст реквизитов.</li>
            <li>Сделка будет брать отсюда, что именно отправлять клиенту в Telegram.</li>
          </ul>
        ) : null}

        <div className="record-grid">
          {data.rows.map((bank) => (
            <article className="record-card" key={bank.id}>
              <div className="status-line">
                <div className="record-title">{bank.name}</div>
                <span>{bank.isActive ? "ACTIVE" : "DISABLED"}</span>
              </div>
              <div className="record-meta">
                {bank.phone ?? "без телефона"} · отправка: {getInstructionLabel(bank.instructionType)} · {bank.branch?.name ?? "без филиала"}
              </div>
              <div className="record-kpi-row">
                <div className="record-kpi">
                  <span>Сделки аренды</span>
                  <strong>{bank._count.rentals}</strong>
                </div>
                <div className="record-kpi">
                  <span>Сделки выкупа</span>
                  <strong>{bank._count.buyouts}</strong>
                </div>
                <div className="record-kpi">
                  <span>Операции</span>
                  <strong>{bank._count.transactions}</strong>
                </div>
              </div>
              <div className="record-tags">
                {bank.assets.length > 0 ? bank.assets.map((asset) => (
                  <span className="tag-chip" key={asset.id}>
                    {asset.type === "QR" ? "QR" : "Реквизиты"}: {asset.title}{asset.isPrimary ? " · основное" : ""}
                  </span>
                )) : <span className="tag-chip">Пока нет QR или реквизитов</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
