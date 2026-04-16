"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { OrderCreateWorkspaceData } from "../lib/order-create-api";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

type DealKind = "RENTAL" | "BUYOUT";
type PaymentCadence = "WEEKLY" | "MONTHLY";
type ClientOption = OrderCreateWorkspaceData["clients"][number];
type BikeOption = OrderCreateWorkspaceData["bikes"][number];
type BankOption = OrderCreateWorkspaceData["banks"][number];
type EquipmentCatalogOption = OrderCreateWorkspaceData["equipmentCatalog"][number];
type SelectedEquipmentItem = {
  catalogItemId?: string | null;
  type: EquipmentCatalogOption["type"];
  label: string;
  quantity: number;
  comment?: string | null;
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(Math.max(0, kopecks) / 100));
}

function formatDateInputValue(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);

    const year = parts.find((part) => part.type === "year")?.value ?? "";
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = parts.find((part) => part.type === "day")?.value ?? "";
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // ignore formatting edge cases
  }

  return date.toISOString().slice(0, 10);
}

function getBikeLabel(bike: BikeOption) {
  const parts = [bike.title];
  if (bike.internalCode) {
    parts.push(bike.internalCode);
  }
  if (bike.article) {
    parts.push(bike.article);
  }
  return parts.join(" · ");
}

function getClientLabel(client: ClientOption) {
  const parts = [client.fullName];
  if (client.primaryPhone) {
    parts.push(client.primaryPhone);
  }
  return parts.join(" · ");
}

function pickBankAsset(bank: BankOption | null) {
  if (!bank) {
    return null;
  }

  return bank.assets.find((asset) => asset.isPrimary) ?? bank.assets[0] ?? null;
}

function formatEquipmentTypeLabel(type: EquipmentCatalogOption["type"]) {
  switch (type) {
    case "BATTERY":
      return "АКБ";
    case "CHARGER":
      return "Зарядка";
    case "HELMET":
      return "Шлем";
    case "CHAIN_LOCK":
      return "Цепной замок";
    default:
      return "Прочее";
  }
}

function QuickLookupField(props: {
  label: string;
  placeholder: string;
  query: string;
  loading: boolean;
  results: Array<{
    id: string;
    title: string;
    subtitle?: string | null;
  }>;
  selectedTitle: string | null;
  selectedSubtitle?: string | null;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  emptyLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="orders-lookup-field">
      <label className="action-field">
        <span>{props.label}</span>
        <input
          className="action-input"
          placeholder={props.placeholder}
          type="search"
          value={props.query}
          onBlur={() => {
            window.setTimeout(() => setIsOpen(false), 120);
          }}
          onChange={(event) => {
            props.onQueryChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
        />
      </label>

      {props.selectedTitle ? (
        <div className="orders-lookup-selected">
          <strong>{props.selectedTitle}</strong>
          {props.selectedSubtitle ? <span>{props.selectedSubtitle}</span> : null}
        </div>
      ) : null}

      {isOpen ? (
        <div className="orders-lookup-results">
          {props.loading ? <div className="orders-lookup-empty">Ищу...</div> : null}
          {!props.loading && props.results.length === 0 ? (
            <div className="orders-lookup-empty">{props.emptyLabel}</div>
          ) : null}
          {!props.loading && props.results.map((item) => (
            <button
              className="orders-lookup-option"
              key={item.id}
              title={item.subtitle ? `${item.title} · ${item.subtitle}` : item.title}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                props.onSelect(item.id);
                setIsOpen(false);
              }}
            >
              <strong className="orders-lookup-option-title">{item.title}</strong>
              {item.subtitle ? <span>{item.subtitle}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuickClientCreate(props: {
  onCreated: (client: ClientOption) => void;
  onCancel: () => void;
}) {
  const canEditClient = useHasPermission("clients.edit");
  const [isPending, startTransition] = useTransition();
  const [clientType, setClientType] = useState<"INDIVIDUAL" | "LEGAL_ENTITY">("INDIVIDUAL");
  const [companyName, setCompanyName] = useState("");
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [phone, setPhone] = useState("");
  const [telegramHandle, setTelegramHandle] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);

    const fullName = clientType === "LEGAL_ENTITY"
      ? companyName.trim()
      : [lastName.trim(), firstName.trim(), middleName.trim()].filter(Boolean).join(" ");

    if (!fullName) {
      setError(clientType === "LEGAL_ENTITY" ? "Укажите название клиента." : "Заполните ФИО.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            fullName,
            clientType,
            primaryPhone: phone.trim() || null,
            telegramHandle: telegramHandle.trim() || null,
            lastName: clientType === "LEGAL_ENTITY" ? null : lastName.trim() || null,
            firstName: clientType === "LEGAL_ENTITY" ? null : firstName.trim() || null,
            middleName: clientType === "LEGAL_ENTITY" ? null : middleName.trim() || null
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        props.onCreated(payload.client);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось создать клиента.");
      }
    });
  }

  return (
    <section className="orders-quick-client">
      <div className="orders-create-title-row">
        <strong>Новый клиент</strong>
        <button className="detail-link" type="button" onClick={props.onCancel}>
          Скрыть
        </button>
      </div>

      <div className="action-field-grid">
        <label className="action-field">
          <span>Тип клиента</span>
          <select className="action-input" value={clientType} onChange={(event) => setClientType(event.target.value as "INDIVIDUAL" | "LEGAL_ENTITY")}>
            <option value="INDIVIDUAL">Физическое лицо</option>
            <option value="LEGAL_ENTITY">Юридическое лицо</option>
          </select>
        </label>

        {clientType === "LEGAL_ENTITY" ? (
          <label className="action-field action-field-wide">
            <span>Название</span>
            <input className="action-input" type="text" value={companyName} onChange={(event) => setCompanyName(event.target.value)} />
          </label>
        ) : (
          <>
            <label className="action-field">
              <span>Фамилия</span>
              <input className="action-input" type="text" value={lastName} onChange={(event) => setLastName(event.target.value)} />
            </label>
            <label className="action-field">
              <span>Имя</span>
              <input className="action-input" type="text" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
            </label>
            <label className="action-field">
              <span>Отчество</span>
              <input className="action-input" type="text" value={middleName} onChange={(event) => setMiddleName(event.target.value)} />
            </label>
          </>
        )}

        <label className="action-field">
          <span>Телефон</span>
          <input className="action-input" type="text" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </label>

        <label className="action-field">
          <span>Telegram</span>
          <input className="action-input" type="text" value={telegramHandle} onChange={(event) => setTelegramHandle(event.target.value)} />
        </label>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canEditClient ? <p className="route-card-note">Недостаточно прав для создания клиента.</p> : null}

      <div className="record-actions">
        <button className="action-button" disabled={!canEditClient || isPending} type="button" onClick={submit}>
          {isPending ? "Создаю..." : "Создать клиента"}
        </button>
      </div>
    </section>
  );
}

export function OrderCreateForm(props: {
  workspace: OrderCreateWorkspaceData;
}) {
  const router = useRouter();
  const canCreateRental = useHasPermission("rentals.create");
  const canCreateBuyout = useHasPermission("buyouts.create");
  const [isPending, startTransition] = useTransition();
  const initialKind: DealKind = props.workspace.bikes.some((bike) => bike.rentalTariffGroup) ? "RENTAL" : "BUYOUT";
  const [kind, setKind] = useState<DealKind>(initialKind);
  const [clientOptions, setClientOptions] = useState(props.workspace.clients);
  const [bikeOptions, setBikeOptions] = useState(props.workspace.bikes);
  const [selectedClient, setSelectedClient] = useState<ClientOption | null>(null);
  const [selectedBike, setSelectedBike] = useState<BikeOption | null>(null);
  const [clientQuery, setClientQuery] = useState("");
  const [bikeQuery, setBikeQuery] = useState("");
  const [clientSearchLoading, setClientSearchLoading] = useState(false);
  const [bikeSearchLoading, setBikeSearchLoading] = useState(false);
  const [showQuickClientCreate, setShowQuickClientCreate] = useState(false);
  const [bankId, setBankId] = useState("");
  const [startsAt, setStartsAt] = useState(formatDateInputValue());
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [durationDays, setDurationDays] = useState(7);
  const [paymentCadence, setPaymentCadence] = useState<PaymentCadence>("MONTHLY");
  const [selectedEquipment, setSelectedEquipment] = useState<SelectedEquipmentItem[]>([]);
  const [catalogEquipmentId, setCatalogEquipmentId] = useState("");
  const [customEquipmentLabel, setCustomEquipmentLabel] = useState("");

  const visibleBikeOptions = bikeOptions.filter((bike) => (
    kind === "RENTAL" ? Boolean(bike.rentalTariffGroup) : Boolean(bike.buyoutTariffGroup)
  ));

  const selectedRentalGroup = selectedBike
    ? props.workspace.tariffGroups.find((group) => group.id === selectedBike.rentalTariffGroup?.id && group.kind === "RENTAL") ?? null
    : null;
  const selectedBuyoutGroup = selectedBike
    ? props.workspace.tariffGroups.find((group) => group.id === selectedBike.buyoutTariffGroup?.id && group.kind === "BUYOUT") ?? null
    : null;
  const selectedBank = props.workspace.banks.find((bank) => bank.id === bankId) ?? null;
  const selectedBankAsset = pickBankAsset(selectedBank);
  const quickEquipmentCatalogMap = new Map(
    props.workspace.equipmentCatalog.map((item) => [`${item.type}:${item.label}`, item] as const)
  );
  const firstEquipmentByType = new Map<EquipmentCatalogOption["type"], EquipmentCatalogOption>();

  for (const item of props.workspace.equipmentCatalog) {
    if (!firstEquipmentByType.has(item.type)) {
      firstEquipmentByType.set(item.type, item);
    }
  }

  function appendEquipment(nextItem: SelectedEquipmentItem) {
    setSelectedEquipment((current) => {
      const matchIndex = current.findIndex((item) => (
        (item.catalogItemId ?? "") === (nextItem.catalogItemId ?? "")
        && item.label === nextItem.label
      ));

      if (matchIndex === -1) {
        return [...current, nextItem];
      }

      return current.map((item, index) => (
        index === matchIndex
          ? { ...item, quantity: item.quantity + nextItem.quantity }
          : item
      ));
    });
  }

  function addQuickEquipment(type: EquipmentCatalogOption["type"]) {
    const catalogItem = firstEquipmentByType.get(type)
      ?? quickEquipmentCatalogMap.get(`${type}:${formatEquipmentTypeLabel(type)}`)
      ?? null;

    appendEquipment({
      catalogItemId: catalogItem?.id ?? null,
      type,
      label: catalogItem?.label ?? formatEquipmentTypeLabel(type),
      quantity: 1
    });
  }

  function addCatalogEquipment() {
    const catalogItem = props.workspace.equipmentCatalog.find((item) => item.id === catalogEquipmentId) ?? null;
    if (!catalogItem) {
      return;
    }

    appendEquipment({
      catalogItemId: catalogItem.id,
      type: catalogItem.type,
      label: catalogItem.label,
      quantity: 1
    });
    setCatalogEquipmentId("");
  }

  function addCustomEquipment() {
    const normalized = customEquipmentLabel.trim();
    if (!normalized) {
      return;
    }

    appendEquipment({
      catalogItemId: null,
      type: "OTHER",
      label: normalized,
      quantity: 1
    });
    setCustomEquipmentLabel("");
  }

  function removeEquipment(indexToRemove: number) {
    setSelectedEquipment((current) => current.filter((_, index) => index !== indexToRemove));
  }

  useEffect(() => {
    let ignore = false;
    const search = clientQuery.trim();

    if (!search) {
      setClientOptions(props.workspace.clients);
      return;
    }

    setClientSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients?tenantSlug=${encodeURIComponent(tenantSlug)}&limit=12&q=${encodeURIComponent(search)}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        if (!ignore) {
          setClientOptions(payload.rows ?? []);
        }
      } catch {
        if (!ignore) {
          setClientOptions([]);
        }
      } finally {
        if (!ignore) {
          setClientSearchLoading(false);
        }
      }
    }, 220);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [clientQuery, props.workspace.clients]);

  useEffect(() => {
    let ignore = false;
    const search = bikeQuery.trim();

    if (!search) {
      setBikeOptions(props.workspace.bikes);
      return;
    }

    setBikeSearchLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/bikes?tenantSlug=${encodeURIComponent(tenantSlug)}&status=AVAILABLE&limit=24&q=${encodeURIComponent(search)}`, {
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        if (!ignore) {
          setBikeOptions(payload.rows ?? []);
        }
      } catch {
        if (!ignore) {
          setBikeOptions([]);
        }
      } finally {
        if (!ignore) {
          setBikeSearchLoading(false);
        }
      }
    }, 220);

    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [bikeQuery, props.workspace.bikes]);

  useEffect(() => {
    if (!selectedBike) {
      return;
    }

    const canUseBike = kind === "RENTAL" ? Boolean(selectedBike.rentalTariffGroup) : Boolean(selectedBike.buyoutTariffGroup);
    if (!canUseBike) {
      setSelectedBike(null);
      setBikeQuery("");
    }
  }, [kind, selectedBike]);

  useEffect(() => {
    if (!selectedRentalGroup) {
      return;
    }

    const preferred = selectedRentalGroup.rates.find((rate) => rate.durationDays === 7) ?? selectedRentalGroup.rates[0];
    if (preferred && !selectedRentalGroup.rates.some((rate) => rate.durationDays === durationDays)) {
      setDurationDays(preferred.durationDays);
    }
  }, [durationDays, selectedRentalGroup]);

  useEffect(() => {
    if (!selectedBuyoutGroup) {
      return;
    }

    const hasMonthly = selectedBuyoutGroup.rates.some((rate) => rate.durationDays === 30);
    const hasWeekly = selectedBuyoutGroup.rates.some((rate) => rate.durationDays === 7);
    if (paymentCadence === "MONTHLY" && hasMonthly) {
      return;
    }
    if (paymentCadence === "WEEKLY" && hasWeekly) {
      return;
    }
    setPaymentCadence(hasMonthly ? "MONTHLY" : "WEEKLY");
  }, [paymentCadence, selectedBuyoutGroup]);

  const activeRentalRate = selectedRentalGroup?.rates.find((rate) => rate.durationDays === durationDays) ?? null;
  const activeBuyoutRate = selectedBuyoutGroup?.rates.find((rate) => (
    paymentCadence === "MONTHLY" ? rate.durationDays === 30 : rate.durationDays === 7
  )) ?? null;
  const canCreateCurrentDeal = kind === "RENTAL" ? canCreateRental : canCreateBuyout;

  function selectClientById(clientId: string) {
    const client = clientOptions.find((row) => row.id === clientId) ?? props.workspace.clients.find((row) => row.id === clientId) ?? null;
    setSelectedClient(client);
    setClientQuery(client ? getClientLabel(client) : "");
    setShowQuickClientCreate(false);
  }

  function selectBikeById(bikeId: string) {
    const bike = visibleBikeOptions.find((row) => row.id === bikeId) ?? props.workspace.bikes.find((row) => row.id === bikeId) ?? null;
    setSelectedBike(bike);
    setBikeQuery(bike ? getBikeLabel(bike) : "");
  }

  function switchKind(nextKind: DealKind) {
    setKind(nextKind);
    setError(null);
    setStatus(null);
  }

  function handleCreatedClient(client: ClientOption) {
    setClientOptions((current) => [client, ...current.filter((row) => row.id !== client.id)]);
    setSelectedClient(client);
    setClientQuery(getClientLabel(client));
    setShowQuickClientCreate(false);
  }

  function submit() {
    setError(null);
    setStatus(null);

    if (!selectedClient?.id || !selectedBike?.id) {
      setError("Выберите клиента и велосипед.");
      return;
    }

    if (kind === "RENTAL" && !activeRentalRate) {
      setError("У выбранного велосипеда нет тарифа аренды.");
      return;
    }

    if (kind === "BUYOUT" && !activeBuyoutRate) {
      setError("У выбранного велосипеда нет тарифа выкупа.");
      return;
    }

    startTransition(async () => {
      try {
        const endpoint = kind === "RENTAL" ? "/rentals" : "/buyouts";
        const body = kind === "RENTAL"
          ? {
              tenantSlug: props.workspace.tenantSlug,
              clientId: selectedClient.id,
              bikeId: selectedBike.id,
              durationDays,
              equipment: selectedEquipment,
              startsAt,
              bankId: bankId || undefined,
              comment: comment.trim() || undefined
            }
          : {
              tenantSlug: props.workspace.tenantSlug,
              clientId: selectedClient.id,
              bikeId: selectedBike.id,
              paymentCadence,
              equipment: selectedEquipment,
              startsAt,
              bankId: bankId || undefined,
              comment: comment.trim() || undefined
            };

        const response = await fetch(`${getApiBase()}${endpoint}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Заказ ${payload?.deal?.dealNumber ?? ""} создан.`);
        const focusKind = payload?.deal?.kind ?? kind;
        const focusDealId = payload?.deal?.id ?? "";
        const nextHref = focusDealId
          ? `/orders?focusKind=${encodeURIComponent(focusKind)}&focusDealId=${encodeURIComponent(focusDealId)}`
          : "/orders";
        router.push(nextHref);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось создать заказ.");
      }
    });
  }

  return (
    <section className="section-stack">
      <section className="surface-card orders-create-card">
        <div className="orders-create-head">
          <div>
            <div className="surface-kicker">Новый заказ</div>
            <h3>Быстрое оформление сделки</h3>
            <p className="route-card-note">
              Сначала найдите клиента и свободный велосипед. Сумма берется из тарифа велосипеда.
            </p>
          </div>

          <Link className="detail-back-link" href="/orders">
            Назад в заказы
          </Link>
        </div>

        <div className="tariff-kind-switcher">
          {(["RENTAL", "BUYOUT"] as DealKind[]).map((nextKind) => (
            <button
              className={["tariff-kind-button", kind === nextKind ? "is-active" : ""].join(" ")}
              key={nextKind}
              type="button"
              onClick={() => switchKind(nextKind)}
            >
              {nextKind === "RENTAL" ? "Аренда" : "Выкуп"}
            </button>
          ))}
        </div>

        <div className="orders-create-grid">
          <section className="orders-create-column">
            <div className="orders-create-title-row">
              <strong>Клиент</strong>
              <button className="inline-text-button" type="button" onClick={() => setShowQuickClientCreate((current) => !current)}>
                {showQuickClientCreate ? "Скрыть" : "Новый клиент"}
              </button>
            </div>

            <QuickLookupField
              emptyLabel="Клиенты не найдены."
              label="Поиск клиента"
              loading={clientSearchLoading}
              placeholder="ФИО, телефон, Telegram"
              query={clientQuery}
              results={clientOptions.map((client) => ({
                id: client.id,
                title: client.fullName,
                subtitle: client.primaryPhone ?? client.telegramHandle ?? null
              }))}
              selectedSubtitle={selectedClient?.primaryPhone ?? selectedClient?.telegramHandle ?? null}
              selectedTitle={selectedClient?.fullName ?? null}
              onQueryChange={(value) => {
                setClientQuery(value);
                if (selectedClient && value !== getClientLabel(selectedClient)) {
                  setSelectedClient(null);
                }
              }}
              onSelect={selectClientById}
            />

            {showQuickClientCreate ? (
              <QuickClientCreate onCancel={() => setShowQuickClientCreate(false)} onCreated={handleCreatedClient} />
            ) : null}
          </section>

          <section className="orders-create-column">
            <strong>Велосипед</strong>
            <QuickLookupField
              emptyLabel="Свободные велосипеды не найдены."
              label="Поиск велосипеда"
              loading={bikeSearchLoading}
              placeholder="Название, артикул, код"
              query={bikeQuery}
              results={visibleBikeOptions.map((bike) => ({
                id: bike.id,
                title: bike.title,
                subtitle: [bike.internalCode, bike.article].filter(Boolean).join(" · ") || null
              }))}
              selectedSubtitle={selectedBike ? [selectedBike.internalCode, selectedBike.article].filter(Boolean).join(" · ") : null}
              selectedTitle={selectedBike?.title ?? null}
              onQueryChange={(value) => {
                setBikeQuery(value);
                if (selectedBike && value !== getBikeLabel(selectedBike)) {
                  setSelectedBike(null);
                }
              }}
              onSelect={selectBikeById}
            />

            <div className="action-field-grid">
              <label className="action-field">
                <span>Дата начала</span>
                <input
                  className="action-input"
                  type="date"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              </label>

              <label className="action-field">
                <span>Банк</span>
                <select className="action-input" value={bankId} onChange={(event) => setBankId(event.target.value)}>
                  <option value="">Без банка</option>
                  {props.workspace.banks.map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        </div>
      </section>

      <section className="surface-card orders-create-card">
        <div className="surface-kicker">Тариф</div>
        {kind === "RENTAL" ? (
          selectedRentalGroup ? (
            <div className="orders-create-tariff-stack">
              <div className="orders-create-summary">
                <strong>{selectedRentalGroup.name}</strong>
                <span>Залог: {formatMoney(selectedRentalGroup.rules.depositTargetKopecks)} руб.</span>
                <span>
                  Автоштраф: {selectedRentalGroup.rules.autoPenaltyEnabled
                    ? `${formatMoney(selectedRentalGroup.rules.autoPenaltyDailyKopecks)} руб./день`
                    : "выключен"}
                </span>
              </div>

              <div className="tariff-kind-switcher">
                {selectedRentalGroup.rates.map((rate) => (
                  <button
                    className={["tariff-kind-button", durationDays === rate.durationDays ? "is-active" : ""].join(" ")}
                    key={rate.id}
                    type="button"
                    onClick={() => setDurationDays(rate.durationDays)}
                  >
                    {rate.label} · {formatMoney(rate.amountKopecks)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="route-card-note">Сначала выберите велосипед с закрепленным тарифом аренды.</p>
          )
        ) : selectedBuyoutGroup ? (
          <div className="orders-create-tariff-stack">
            <div className="orders-create-summary">
              <strong>{selectedBuyoutGroup.name}</strong>
              <span>Срок: 6 месяцев</span>
              <span>
                Автоштраф: {selectedBuyoutGroup.rules.autoPenaltyEnabled
                  ? `${formatMoney(selectedBuyoutGroup.rules.autoPenaltyDailyKopecks)} руб./день`
                  : "выключен"}
              </span>
            </div>

            <div className="tariff-kind-switcher">
              {selectedBuyoutGroup.rates
                .filter((rate) => rate.durationDays === 7 || rate.durationDays === 30)
                .map((rate) => {
                  const cadenceValue: PaymentCadence = rate.durationDays === 30 ? "MONTHLY" : "WEEKLY";
                  return (
                    <button
                      className={["tariff-kind-button", paymentCadence === cadenceValue ? "is-active" : ""].join(" ")}
                      key={rate.id}
                      type="button"
                      onClick={() => setPaymentCadence(cadenceValue)}
                    >
                      {rate.label} · {formatMoney(rate.amountKopecks)}
                    </button>
                  );
                })}
            </div>
          </div>
        ) : (
          <p className="route-card-note">Сначала выберите велосипед с закрепленным тарифом выкупа.</p>
        )}

        <label className="action-field">
          <span>Комментарий</span>
          <textarea
            className="action-input action-textarea"
            maxLength={400}
            placeholder="Необязательно"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
      </section>

      <section className="surface-card orders-create-card">
        <div className="surface-kicker">Комплект / доп. оборудование</div>
        <div className="orders-create-title-row">
          <strong>Что выдаем клиенту вместе с велосипедом</strong>
          <span className="orders-expand-muted">
            {selectedEquipment.length > 0 ? `позиций: ${selectedEquipment.length}` : "фиксируется в сделке и документах"}
          </span>
        </div>

        <div className="tariff-kind-switcher equipment-quick-buttons">
          {([
            ["BATTERY", "АКБ"],
            ["CHARGER", "Зарядка"],
            ["HELMET", "Шлем"],
            ["CHAIN_LOCK", "Цепной замок"],
            ["OTHER", "Прочее"]
          ] as Array<[EquipmentCatalogOption["type"], string]>).map(([type, label]) => (
            <button
              className="tariff-kind-button"
              key={type}
              type="button"
              onClick={() => addQuickEquipment(type)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="orders-inline-payment-grid orders-equipment-grid">
          <label className="action-field">
            <span>Добавить из справочника</span>
            <select className="action-input" value={catalogEquipmentId} onChange={(event) => setCatalogEquipmentId(event.target.value)}>
              <option value="">Выберите позицию</option>
              {props.workspace.equipmentCatalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {formatEquipmentTypeLabel(item.type)}
                </option>
              ))}
            </select>
          </label>

          <div className="action-field orders-inline-action-field">
            <span>Из справочника</span>
            <button className="action-button action-button-secondary" disabled={!catalogEquipmentId} type="button" onClick={addCatalogEquipment}>
              Добавить
            </button>
          </div>

          <label className="action-field orders-inline-payment-comment">
            <span>Своя позиция</span>
            <input
              className="action-input"
              placeholder="Например, держатель телефона"
              type="text"
              value={customEquipmentLabel}
              onChange={(event) => setCustomEquipmentLabel(event.target.value)}
            />
          </label>

          <div className="action-field orders-inline-action-field">
            <span>Своя позиция</span>
            <button className="action-button action-button-secondary" disabled={!customEquipmentLabel.trim()} type="button" onClick={addCustomEquipment}>
              Добавить
            </button>
          </div>
        </div>

        {selectedEquipment.length > 0 ? (
          <div className="orders-equipment-list">
            {selectedEquipment.map((item, index) => (
              <div className="orders-equipment-row" key={`${item.catalogItemId ?? "custom"}-${item.label}-${index}`}>
                <div className="orders-equipment-main">
                  <strong>{item.label}</strong>
                  <span>{formatEquipmentTypeLabel(item.type)} · ×{item.quantity}</span>
                </div>
                <button className="detail-link" type="button" onClick={() => removeEquipment(index)}>
                  Убрать
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="route-card-note">
            Если ничего не выбрано, сделка будет создана без дополнительного оборудования.
          </p>
        )}
      </section>

      <section className="surface-card orders-create-card">
        <div className="surface-kicker">Банк и отправка</div>
        {selectedBank ? (
          <div className="orders-bank-preview">
            <div className="orders-create-title-row">
              <strong>{selectedBank.name}</strong>
              <span className="orders-bank-preview-type">
                {selectedBank.instructionType === "QR" ? "Клиенту уйдет QR" : "Клиенту уйдут реквизиты"}
              </span>
            </div>

            {selectedBankAsset?.title ? <p className="orders-expand-note">{selectedBankAsset.title}</p> : null}
            {selectedBankAsset?.textBody ? (
              <p className="orders-expand-note">{selectedBankAsset.textBody}</p>
            ) : selectedBank.comment ? (
              <p className="orders-expand-note">{selectedBank.comment}</p>
            ) : null}

            <div className="orders-expand-tags">
              {selectedBank.phone ? <span className="tag-chip">{selectedBank.phone}</span> : null}
              {selectedBankAsset?.filePath ? <span className="tag-chip">QR-файл загружен</span> : null}
            </div>
          </div>
        ) : (
          <p className="route-card-note">Если выбрать банк, менеджер сразу увидит, что уйдет клиенту: QR или реквизиты.</p>
        )}

        <div className="record-actions">
          <button
            className="action-button"
            disabled={!canCreateCurrentDeal || isPending || !selectedClient || !selectedBike || (kind === "RENTAL" ? !activeRentalRate : !activeBuyoutRate)}
            type="button"
            onClick={submit}
          >
            {isPending ? "Создаю..." : "Создать заказ"}
          </button>
        </div>

        {error ? <p className="action-status is-error">{error}</p> : null}
        {status ? <p className="action-status is-success">{status}</p> : null}
        {!canCreateCurrentDeal ? (
          <p className="route-card-note">
            Недостаточно прав для создания {kind === "RENTAL" ? "аренды" : "выкупа"}.
          </p>
        ) : null}
      </section>
    </section>
  );
}
