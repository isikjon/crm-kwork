"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { TariffsWorkspaceData } from "../lib/tariffs-api";
import { useHasPermission } from "./auth-actor-context";

type TariffGroupRow = TariffsWorkspaceData["rows"][number];
type BikeRow = TariffsWorkspaceData["bikes"][number];
type TariffKind = TariffGroupRow["kind"];

type RateDraft = {
  key: string;
  label: string;
  durationDays: string;
  amountRubles: string;
};

const KIND_COPY: Record<TariffKind, {
  title: string;
  shortTitle: string;
  createTitle: string;
  description: string;
}> = {
  RENTAL: {
    title: "Группы аренды",
    shortTitle: "Аренда",
    createTitle: "Новая группа аренды",
    description: "Ставки, залог и автоштраф."
  },
  BUYOUT: {
    title: "Группы выкупа",
    shortTitle: "Выкуп",
    createTitle: "Новая группа выкупа",
    description: "Неделя, месяц и общие правила."
  }
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

function formatCount(value: number) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function createRateDraft(
  label: string,
  durationDays: number,
  amountKopecks: number
): RateDraft {
  return {
    key: `${label}-${durationDays}-${Math.random().toString(16).slice(2)}`,
    label,
    durationDays: String(durationDays),
    amountRubles: String(Math.round(amountKopecks / 100))
  };
}

function getDefaultRates(kind: TariffKind) {
  if (kind === "BUYOUT") {
    return [
      createRateDraft("Неделя", 7, 550_000),
      createRateDraft("Месяц", 30, 2_200_000)
    ];
  }

  return [
    createRateDraft("1 день", 1, 70_000),
    createRateDraft("7 дней", 7, 450_000),
    createRateDraft("30 дней", 30, 1_500_000)
  ];
}

function toRatesPayload(rates: RateDraft[], kind: TariffKind) {
  return rates
    .map((rate) => ({
      label: rate.label.trim() || `Ставка ${rate.durationDays || "?"}`,
      durationDays: Math.max(1, Math.trunc(Number(rate.durationDays || "0"))),
      amountKopecks: Math.max(0, Math.round(Number(rate.amountRubles || "0") * 100)),
      bonusDays: 0
    }))
    .filter((rate) => Number.isFinite(rate.durationDays) && rate.durationDays > 0);
}

function getAssignedGroupId(bike: BikeRow, kind: TariffKind) {
  return kind === "RENTAL" ? bike.rentalTariffGroupId : bike.buyoutTariffGroupId;
}

function getAssignedGroup(bike: BikeRow, kind: TariffKind) {
  return kind === "RENTAL" ? bike.rentalTariffGroup : bike.buyoutTariffGroup;
}

function KindSwitcher(props: {
  kind: TariffKind;
  onChange: (kind: TariffKind) => void;
}) {
  return (
    <div className="tariff-kind-switcher">
      {(["RENTAL", "BUYOUT"] as TariffKind[]).map((kind) => (
        <button
          className={["tariff-kind-button", props.kind === kind ? "is-active" : ""].join(" ")}
          key={kind}
          type="button"
          onClick={() => props.onChange(kind)}
        >
          {KIND_COPY[kind].shortTitle}
        </button>
      ))}
    </div>
  );
}

function RateRowsEditor(props: {
  kind: TariffKind;
  rates: RateDraft[];
  onChange: (rates: RateDraft[]) => void;
}) {
  function updateRate(key: string, patch: Partial<RateDraft>) {
    props.onChange(props.rates.map((rate) => (rate.key === key ? { ...rate, ...patch } : rate)));
  }

  function addRate() {
    props.onChange([
      ...props.rates,
      createRateDraft(props.kind === "RENTAL" ? "Новый срок" : "Новый шаг", props.kind === "RENTAL" ? 14 : 30, 0)
    ]);
  }

  function removeRate(key: string) {
    props.onChange(props.rates.filter((rate) => rate.key !== key));
  }

  return (
    <div className="tariff-rates-stack">
      {props.rates.map((rate) => (
        <div className={["tariff-rate-row", props.kind === "RENTAL" ? "is-rental" : "is-buyout"].join(" ")} key={rate.key}>
          <label className="action-field">
            <span>Название</span>
            <input
              className="action-input"
              maxLength={80}
              type="text"
              value={rate.label}
              onChange={(event) => updateRate(rate.key, { label: event.target.value })}
            />
          </label>

          <label className="action-field">
            <span>{props.kind === "RENTAL" ? "Дней" : "Шаг, дней"}</span>
            <input
              className="action-input"
              inputMode="numeric"
              min={1}
              step={1}
              type="number"
              value={rate.durationDays}
              onChange={(event) => updateRate(rate.key, { durationDays: event.target.value })}
            />
          </label>

          <label className="action-field">
            <span>Сумма, руб.</span>
            <input
              className="action-input"
              inputMode="numeric"
              min={0}
              step={1}
              type="number"
              value={rate.amountRubles}
              onChange={(event) => updateRate(rate.key, { amountRubles: event.target.value })}
            />
          </label>

          <button className="action-button is-secondary tariff-rate-remove" type="button" onClick={() => removeRate(rate.key)}>
            Убрать
          </button>
        </div>
      ))}

      <div className="record-actions">
        <button className="action-button is-secondary" type="button" onClick={addRate}>
          Добавить ставку
        </button>
      </div>
    </div>
  );
}

function CreateTariffGroupForm() {
  const router = useRouter();
  const canManageTariffs = useHasPermission("tariffs.manage");
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [kind, setKind] = useState<TariffKind>("RENTAL");
  const [name, setName] = useState("");
  const [depositRubles, setDepositRubles] = useState("0");
  const [autoPenaltyEnabled, setAutoPenaltyEnabled] = useState(true);
  const [autoPenaltyDailyRubles, setAutoPenaltyDailyRubles] = useState("0");
  const [graceDays, setGraceDays] = useState("0");
  const [rates, setRates] = useState<RateDraft[]>(getDefaultRates("RENTAL"));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function switchKind(nextKind: TariffKind) {
    setKind(nextKind);
    setRates(getDefaultRates(nextKind));
    setAutoPenaltyEnabled(nextKind === "RENTAL");
    setAutoPenaltyDailyRubles("0");
    setStatus(null);
    setError(null);
  }

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/tariffs`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug: "prokolesa",
            kind,
            name,
            description: "",
            depositTargetKopecks: Math.max(0, Math.round(Number(depositRubles || "0") * 100)),
            autoPenaltyEnabled,
            autoPenaltyDailyKopecks: Math.max(0, Math.round(Number(autoPenaltyDailyRubles || "0") * 100)),
            graceDays: Math.max(0, Math.trunc(Number(graceDays || "0"))),
            rates: toRatesPayload(rates, kind)
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Группа "${payload?.group?.name ?? name}" создана.`);
        setName("");
        setRates(getDefaultRates(kind));
        setIsOpen(false);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось создать группу.");
      }
    });
  }

  return (
    <section className="surface-card">
      <div className="tariff-create-head">
        <div>
          <div className="surface-kicker">Новая группа</div>
          <h3>Добавить тариф</h3>
        </div>
        <button className="action-button is-secondary" type="button" onClick={() => setIsOpen((current) => !current)}>
          {isOpen ? "Скрыть" : "Добавить"}
        </button>
      </div>

      {isOpen ? (
        <>
          <p className="route-card-note">{KIND_COPY[kind].description}</p>

          <KindSwitcher kind={kind} onChange={switchKind} />

          <label className="action-field">
            <span>Название</span>
            <input
              className="action-input"
              maxLength={120}
              placeholder={kind === "RENTAL" ? "Например: Monster 700 / 4500 / 15000" : "Например: Выкуп 5500 / 22000"}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="tariff-compact-grid">
            <label className="action-field">
              <span>Залог, руб.</span>
              <input
                className="action-input"
                inputMode="numeric"
                min={0}
                step={1}
                type="number"
                value={depositRubles}
                onChange={(event) => setDepositRubles(event.target.value)}
              />
            </label>

            <div className="action-field">
              <span>Автоштраф</span>
              <div className="tariff-penalty-inline">
                <label className="action-toggle">
                  <input checked={autoPenaltyEnabled} type="checkbox" onChange={(event) => setAutoPenaltyEnabled(event.target.checked)} />
                  <span>Вкл</span>
                </label>
                <input
                  className="action-input tariff-mini-input"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  type="number"
                  value={autoPenaltyDailyRubles}
                  onChange={(event) => setAutoPenaltyDailyRubles(event.target.value)}
                />
              </div>
            </div>

            <label className="action-field">
              <span>Льгота, дней</span>
              <input
                className="action-input"
                inputMode="numeric"
                min={0}
                step={1}
                type="number"
                value={graceDays}
                onChange={(event) => setGraceDays(event.target.value)}
              />
            </label>
          </div>

          <div className="surface-kicker">Ставки</div>
          <RateRowsEditor kind={kind} rates={rates} onChange={setRates} />
        </>
      ) : (
        <p className="route-card-note">Создайте группу и закрепите ее за нужными велосипедами.</p>
      )}

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}

      {isOpen ? (
        <div className="record-actions">
        <button className="action-button" disabled={!canManageTariffs || isPending || !name.trim()} type="button" onClick={submit}>
          {isPending ? "Создаю..." : "Создать группу"}
        </button>
        {!canManageTariffs ? <p className="route-card-note">Недостаточно прав для изменения тарифов.</p> : null}
      </div>
      ) : null}
    </section>
  );
}

function TariffGroupRow(props: {
  group: TariffGroupRow;
  bikes: BikeRow[];
}) {
  const router = useRouter();
  const canManageTariffs = useHasPermission("tariffs.manage");
  const [isPending, startTransition] = useTransition();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(props.group.name);
  const [isActive, setIsActive] = useState(props.group.isActive);
  const [depositRubles, setDepositRubles] = useState(String(Math.round(props.group.rules.depositTargetKopecks / 100)));
  const [autoPenaltyEnabled, setAutoPenaltyEnabled] = useState(props.group.rules.autoPenaltyEnabled);
  const [autoPenaltyDailyRubles, setAutoPenaltyDailyRubles] = useState(String(Math.round(props.group.rules.autoPenaltyDailyKopecks / 100)));
  const [graceDays, setGraceDays] = useState(String(props.group.rules.graceDays));
  const [rates, setRates] = useState<RateDraft[]>(
    props.group.rates.map((rate) => createRateDraft(rate.label, rate.durationDays, rate.amountKopecks))
  );
  const [bikeQuery, setBikeQuery] = useState("");
  const [selectedBikeIds, setSelectedBikeIds] = useState<string[]>(
    props.bikes.filter((bike) => getAssignedGroupId(bike, props.group.kind) === props.group.id).map((bike) => bike.id)
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredBikes = props.bikes.filter((bike) => {
    const normalized = bikeQuery.trim().toLocaleLowerCase("ru-RU");
    if (!normalized) {
      return true;
    }

    return [
      bike.title,
      bike.internalCode,
      bike.article ?? ""
    ].some((value) => value.toLocaleLowerCase("ru-RU").includes(normalized));
  });

  async function sendPatch(customBody?: Record<string, unknown>) {
    const response = await fetch(`${getApiBase()}/tariffs/${props.group.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        tenantSlug: "prokolesa",
        kind: props.group.kind,
        name,
        description: props.group.description ?? "",
        isActive,
        depositTargetKopecks: Math.max(0, Math.round(Number(depositRubles || "0") * 100)),
        autoPenaltyEnabled,
        autoPenaltyDailyKopecks: Math.max(0, Math.round(Number(autoPenaltyDailyRubles || "0") * 100)),
        graceDays: Math.max(0, Math.trunc(Number(graceDays || "0"))),
        rates: toRatesPayload(rates, props.group.kind),
        syncActiveDeals: true,
        ...customBody
      })
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
    }
  }

  function savePenaltyQuick() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        await sendPatch();
        setStatus("Автоштраф обновлен.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось обновить автоштраф.");
      }
    });
  }

  function saveDetails() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        await sendPatch();
        setStatus("Группа сохранена.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось обновить группу.");
      }
    });
  }

  function toggleBike(bikeId: string) {
    setSelectedBikeIds((current) => (
      current.includes(bikeId)
        ? current.filter((item) => item !== bikeId)
        : [...current, bikeId]
    ));
  }

  function saveAssignments() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/tariffs/${props.group.id}/bikes`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug: "prokolesa",
            bikeIds: selectedBikeIds,
            syncActiveDeals: true
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Закрепление сохранено: ${payload?.assignedCount ?? selectedBikeIds.length} велосипедов.`);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось закрепить велосипеды.");
      }
    });
  }

  return (
    <div className="tariff-row">
      <div className="tariff-row-summary">
        <div className="tariff-cell tariff-cell-main">
          <div className="record-title">{name}</div>
          <div className="record-meta">
            {props.group.kind === "RENTAL" ? "Аренда" : "Выкуп"} · {isActive ? "активна" : "выключена"}
          </div>
        </div>

        <div className="tariff-cell">
          <div className="tariff-rates-inline">
            {props.group.rates.map((rate) => (
              <span className="tag-chip" key={rate.id}>
                {rate.label} {formatMoney(rate.amountKopecks)}
              </span>
            ))}
          </div>
        </div>

        <div className="tariff-cell">
          <div className="tariff-penalty-box">
            <label className="action-toggle">
              <input checked={autoPenaltyEnabled} type="checkbox" onChange={(event) => setAutoPenaltyEnabled(event.target.checked)} />
              <span>Автоштраф</span>
            </label>
            <div className="tariff-penalty-inline">
              <input
                className="action-input tariff-mini-input"
                inputMode="numeric"
                min={0}
                step={1}
                type="number"
                value={autoPenaltyDailyRubles}
                onChange={(event) => setAutoPenaltyDailyRubles(event.target.value)}
              />
              <button className="action-button is-secondary tariff-mini-button" disabled={!canManageTariffs || isPending} type="button" onClick={savePenaltyQuick}>
                Ок
              </button>
            </div>
          </div>
        </div>

        <div className="tariff-cell">
          <strong>{formatMoney(props.group.rules.depositTargetKopecks)}</strong>
          <div className="record-meta">залог</div>
        </div>

        <div className="tariff-cell">
          <strong>{formatCount(props.group.assignedBikesCount)}</strong>
          <div className="record-meta">велосипедов</div>
        </div>

        <div className="tariff-cell tariff-cell-actions">
          <button className="action-button is-secondary" type="button" onClick={() => setIsOpen((current) => !current)}>
            {isOpen ? "Скрыть" : "Настроить"}
          </button>
        </div>
      </div>

      {isOpen ? (
        <div className="tariff-editor-panel">
          <label className="action-field">
            <span>Название</span>
            <input className="action-input" type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="tariff-compact-grid">
            <label className="action-field">
              <span>Залог, руб.</span>
              <input className="action-input" inputMode="numeric" min={0} step={1} type="number" value={depositRubles} onChange={(event) => setDepositRubles(event.target.value)} />
            </label>

            <label className="action-field">
              <span>Льгота, дней</span>
              <input className="action-input" inputMode="numeric" min={0} step={1} type="number" value={graceDays} onChange={(event) => setGraceDays(event.target.value)} />
            </label>
            <label className="action-field">
              <span>Статус</span>
              <label className="action-toggle">
                <input checked={isActive} type="checkbox" onChange={(event) => setIsActive(event.target.checked)} />
                <span>{isActive ? "Активна" : "Выключена"}</span>
              </label>
            </label>
          </div>

          <div className="surface-kicker">Ставки</div>
          <RateRowsEditor kind={props.group.kind} rates={rates} onChange={setRates} />

          <div className="record-actions">
            <button className="action-button" disabled={!canManageTariffs || isPending} type="button" onClick={saveDetails}>
              {isPending ? "Сохраняю..." : "Сохранить группу"}
            </button>
          </div>

          <div className="surface-kicker">Велосипеды</div>
          <label className="action-field">
            <span>Найти велосипед</span>
            <input
              className="action-input"
              placeholder="Название, код или артикул"
              type="search"
              value={bikeQuery}
              onChange={(event) => setBikeQuery(event.target.value)}
            />
          </label>

          <div className="tariff-bike-list">
            {filteredBikes.map((bike) => {
              const isChecked = selectedBikeIds.includes(bike.id);
              const assignedGroupId = getAssignedGroupId(bike, props.group.kind);
              const assignedGroup = getAssignedGroup(bike, props.group.kind);
              const belongsToAnotherGroup = assignedGroupId && assignedGroupId !== props.group.id;

              return (
                <label className={["tariff-bike-row", isChecked ? "is-selected" : ""].join(" ")} key={bike.id}>
                  <input checked={isChecked} type="checkbox" onChange={() => toggleBike(bike.id)} />
                  <div>
                  <div className="record-title tariff-bike-title">{bike.title}</div>
                  <div className="record-meta">
                    {bike.internalCode} · {bike.status}
                    {bike.article ? ` · ${bike.article}` : ""}
                  </div>
                  {belongsToAnotherGroup ? (
                    <div className="tariff-bike-warning">Сейчас в группе: {assignedGroup?.name}</div>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>

          <div className="record-actions">
            <button className="action-button" disabled={!canManageTariffs || isPending} type="button" onClick={saveAssignments}>
              {isPending ? "Сохраняю..." : "Закрепить велосипеды"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canManageTariffs ? <p className="route-card-note">Недостаточно прав для изменения тарифов.</p> : null}
    </div>
  );
}

function TariffGroupsTable(props: {
  title: string;
  note: string;
  groups: TariffGroupRow[];
  bikes: BikeRow[];
}) {
  return (
    <section className="surface-card">
      <div className="surface-kicker">{props.title}</div>
      <div className="record-meta">{props.note}</div>

      <div className="tariff-table-head">
        <div>Группа</div>
        <div>Ставки</div>
        <div>Автоштраф</div>
        <div>Залог</div>
        <div>Велосипеды</div>
        <div>Действие</div>
      </div>

      <div className="tariff-table-body">
        {props.groups.map((group) => (
          <TariffGroupRow bikes={props.bikes} group={group} key={group.id} />
        ))}
      </div>
    </section>
  );
}

export function TariffsEditor(props: {
  rows: TariffGroupRow[];
  bikes: BikeRow[];
}) {
  const rentalGroups = props.rows.filter((group) => group.kind === "RENTAL");
  const buyoutGroups = props.rows.filter((group) => group.kind === "BUYOUT");

  return (
    <div className="section-stack">
      <section className="surface-card">
        <div className="surface-kicker">Тарифы</div>
        <h3>Только группы и велосипеды</h3>
        <div className="record-tags">
          <span className="tag-chip">аренда: {formatCount(rentalGroups.length)}</span>
          <span className="tag-chip">выкуп: {formatCount(buyoutGroups.length)}</span>
          <span className="tag-chip">велосипедов: {formatCount(props.bikes.length)}</span>
        </div>
      </section>

      <CreateTariffGroupForm />

      <TariffGroupsTable
        bikes={props.bikes}
        groups={rentalGroups}
        note={`Закреплено по аренде: ${formatCount(props.bikes.filter((bike) => bike.rentalTariffGroupId).length)} · без группы: ${formatCount(props.bikes.filter((bike) => !bike.rentalTariffGroupId).length)}.`}
        title="Группы аренды"
      />

      <TariffGroupsTable
        bikes={props.bikes}
        groups={buyoutGroups}
        note={`Закреплено по выкупу: ${formatCount(props.bikes.filter((bike) => bike.buyoutTariffGroupId).length)} · без группы: ${formatCount(props.bikes.filter((bike) => !bike.buyoutTariffGroupId).length)}.`}
        title="Группы выкупа"
      />
    </div>
  );
}
