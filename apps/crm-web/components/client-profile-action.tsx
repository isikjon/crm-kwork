"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

type WorkplaceRow = {
  id: string;
  label: string;
  usageCount: number;
};

type ClientRow = {
  id: string;
  fullName: string;
  clientType: "INDIVIDUAL" | "LEGAL_ENTITY";
  taxId: string | null;
  kpp: string | null;
  ogrn: string | null;
  workplace: string | null;
  courierId: string | null;
  primaryPhone: string | null;
  contactPersonName: string | null;
  telegramHandle: string | null;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  comment: string | null;
  isProblemClient: boolean;
  isThief: boolean;
  flagComment: string | null;
  identityData: {
    actualAddressFull: string | null;
    actualAddressComment: string | null;
  } | null;
  contacts: Array<{
    id: string;
    value: string;
    isPrimary: boolean;
  }>;
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

export function ClientProfileAction(props: {
  client: ClientRow;
  options: WorkplaceRow[];
  compact?: boolean;
  openRequisites?: boolean;
}) {
  const router = useRouter();
  const canEditClient = useHasPermission("clients.edit");
  const canEditIdentity = useHasPermission("clients.identity.edit");
  const canViewIdentity = useHasPermission("clients.identity.view") || canEditIdentity;
  const [isPending, startTransition] = useTransition();

  const [workplaceOptions, setWorkplaceOptions] = useState(props.options);
  const matchedOption = useMemo(
    () => workplaceOptions.find((option) => option.label === props.client.workplace) ?? null,
    [props.client.workplace, workplaceOptions]
  );
  const extraPhoneFromContacts = props.client.contacts.find((row) => row.value !== props.client.primaryPhone)?.value ?? "";
  const [clientType, setClientType] = useState<"INDIVIDUAL" | "LEGAL_ENTITY">(props.client.clientType);
  const [selectedOptionId, setSelectedOptionId] = useState(matchedOption?.id ?? "");
  const [showWorkplaceManager, setShowWorkplaceManager] = useState(false);
  const [newWorkplaceLabel, setNewWorkplaceLabel] = useState("");
  const [workplaceQuery, setWorkplaceQuery] = useState("");
  const [fullName, setFullName] = useState(props.client.fullName ?? "");
  const [courierId, setCourierId] = useState(props.client.courierId ?? "");
  const [taxId, setTaxId] = useState(props.client.taxId ?? "");
  const [kpp, setKpp] = useState(props.client.kpp ?? "");
  const [ogrn, setOgrn] = useState(props.client.ogrn ?? "");
  const [primaryPhone, setPrimaryPhone] = useState(props.client.primaryPhone ?? "");
  const [showSecondPhone, setShowSecondPhone] = useState(Boolean(extraPhoneFromContacts));
  const [secondPhone, setSecondPhone] = useState(extraPhoneFromContacts);
  const [primaryPhoneChoice, setPrimaryPhoneChoice] = useState<"phone1" | "phone2">(
    props.client.primaryPhone ? "phone1" : extraPhoneFromContacts ? "phone2" : "phone1"
  );
  const [contactPersonName, setContactPersonName] = useState(props.client.contactPersonName ?? "");
  const [telegramHandle, setTelegramHandle] = useState(props.client.telegramHandle ?? "");
  const [lastName, setLastName] = useState(props.client.lastName ?? "");
  const [firstName, setFirstName] = useState(props.client.firstName ?? "");
  const [middleName, setMiddleName] = useState(props.client.middleName ?? "");
  const [actualAddressFull, setActualAddressFull] = useState(props.client.identityData?.actualAddressFull ?? "");
  const [actualAddressComment, setActualAddressComment] = useState(props.client.identityData?.actualAddressComment ?? "");
  const [comment, setComment] = useState(props.client.comment ?? "");
  const [isProblemClient, setIsProblemClient] = useState(props.client.isProblemClient);
  const [isThief, setIsThief] = useState(props.client.isThief);
  const [flagComment, setFlagComment] = useState(props.client.flagComment ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLegalEntity = clientType === "LEGAL_ENTITY";
  const filteredWorkplaces = useMemo(() => {
    const search = workplaceQuery.trim().toLocaleLowerCase();
    if (!search) {
      return workplaceOptions;
    }

    return workplaceOptions.filter((option) => option.label.toLocaleLowerCase().includes(search));
  }, [workplaceOptions, workplaceQuery]);

  function buildPhoneContacts() {
    const rows = [
      { key: "phone1" as const, value: primaryPhone.trim() },
      { key: "phone2" as const, value: showSecondPhone ? secondPhone.trim() : "" }
    ].filter((row) => row.value.length > 0);

    return rows.map((row) => ({
      value: row.value,
      isPrimary: primaryPhoneChoice === row.key
    }));
  }

  function save() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/${props.client.id}/profile`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            clientType,
            fullName,
            workplaceOptionId: selectedOptionId || null,
            clearWorkplace: !selectedOptionId,
            courierId,
            taxId,
            kpp,
            ogrn,
            primaryPhone,
            phoneContacts: buildPhoneContacts(),
            contactPersonName,
            telegramHandle,
            lastName: isLegalEntity ? null : lastName,
            firstName: isLegalEntity ? null : firstName,
            middleName: isLegalEntity ? null : middleName,
            ...(canEditIdentity
              ? {
                  actualAddressFull,
                  actualAddressComment: isLegalEntity ? actualAddressComment : null
                }
              : {}),
            comment,
            isProblemClient,
            isThief,
            flagComment
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus("Карточка клиента сохранена.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить данные клиента.");
      }
    });
  }

  function addWorkplace() {
    setStatus(null);
    setError(null);

    if (newWorkplaceLabel.trim().length < 2) {
      setError("Введите название места работы.");
      return;
    }

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/workplaces`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            label: newWorkplaceLabel.trim()
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        const nextWorkplace = payload?.workplace;
        if (nextWorkplace) {
          setWorkplaceOptions((current) => {
            const next = current.filter((row) => row.id !== nextWorkplace.id);
            return [...next, nextWorkplace].sort((left, right) => left.label.localeCompare(right.label, "ru"));
          });
          setSelectedOptionId(nextWorkplace.id);
        }

        setNewWorkplaceLabel("");
        setStatus(payload?.created ? "Место работы добавлено." : "Такое место работы уже есть.");
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось добавить место работы.");
      }
    });
  }

  function removeWorkplace(workplaceId: string) {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const response = await fetch(`${getApiBase()}/clients/workplaces/${workplaceId}?tenantSlug=${encodeURIComponent(tenantSlug)}`, {
          method: "DELETE",
          credentials: "include"
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setWorkplaceOptions((current) => current.filter((row) => row.id !== workplaceId));
        if (selectedOptionId === workplaceId) {
          setSelectedOptionId("");
        }
        setStatus(`Удалено: ${payload?.workplace?.label ?? ""}`);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось удалить место работы.");
      }
    });
  }

  return (
    <div className={`action-card client-form-card${props.compact ? " is-compact" : ""}`}>
      <div className="client-form-sections">
        <details className="client-editor-block client-section-card is-main" open={props.openRequisites}>
          <summary>Основное</summary>
          <div className="client-editor-body">
            <div className="action-field-grid">
              <label className="action-field">
                <span>Тип клиента</span>
                <select className="action-input" value={clientType} onChange={(event) => setClientType(event.target.value as "INDIVIDUAL" | "LEGAL_ENTITY")}>
                  <option value="INDIVIDUAL">Физическое лицо</option>
                  <option value="LEGAL_ENTITY">Юридическое лицо</option>
                </select>
              </label>

              {isLegalEntity ? (
                <>
                  <label className="action-field action-field-wide">
                    <span>Название</span>
                    <input className="action-input" value={fullName} onChange={(event) => setFullName(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>ИНН</span>
                    <input className="action-input" value={taxId} onChange={(event) => setTaxId(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>КПП</span>
                    <input className="action-input" value={kpp} onChange={(event) => setKpp(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>ОГРН</span>
                    <input className="action-input" value={ogrn} onChange={(event) => setOgrn(event.target.value)} />
                  </label>
                </>
              ) : (
                <>
                  <div className="action-field">
                    <div className="field-inline-header">
                      <span>Место работы</span>
                      <div className="field-inline-tools">
                        <button className="inline-icon-button" disabled={!canEditClient} type="button" onClick={() => setShowWorkplaceManager((current) => !current)}>
                          +
                        </button>
                      </div>
                    </div>
                    <select className="action-input" value={selectedOptionId} onChange={(event) => setSelectedOptionId(event.target.value)}>
                      <option value="">Не выбрано</option>
                      {workplaceOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {showWorkplaceManager ? (
                      <div className="mini-lookup-sheet">
                        <div className="mini-lookup-row">
                          <input
                            className="action-input"
                            placeholder="Новое место работы"
                            value={newWorkplaceLabel}
                            onChange={(event) => setNewWorkplaceLabel(event.target.value)}
                          />
                          <button className="inline-text-button" disabled={!canEditClient || isPending} type="button" onClick={addWorkplace}>
                            Сохранить
                          </button>
                        </div>
                        <input
                          className="action-input mini-lookup-search"
                          placeholder="Найти значение"
                          value={workplaceQuery}
                          onChange={(event) => setWorkplaceQuery(event.target.value)}
                        />
                        <div className="mini-lookup-list">
                          {filteredWorkplaces.map((option) => (
                            <div className="mini-lookup-item" key={option.id}>
                              <button className="mini-lookup-select" type="button" onClick={() => setSelectedOptionId(option.id)}>
                                {option.label}
                              </button>
                              <button className="mini-lookup-delete" disabled={!canEditClient || isPending} type="button" onClick={() => removeWorkplace(option.id)}>
                                Удалить
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <label className="action-field">
                    <span>ID курьера</span>
                    <input className="action-input" value={courierId} onChange={(event) => setCourierId(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>Фамилия</span>
                    <input className="action-input" value={lastName} onChange={(event) => setLastName(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>Имя</span>
                    <input className="action-input" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
                  </label>

                  <label className="action-field">
                    <span>Отчество</span>
                    <input className="action-input" value={middleName} onChange={(event) => setMiddleName(event.target.value)} />
                  </label>
                </>
              )}
            </div>
          </div>
        </details>

        <details className="client-editor-block client-section-card client-section-card-contacts" open>
          <summary>Контакты</summary>
          <div className="client-editor-body">
            <div className="action-field-grid">
              <div className="action-field">
                <div className="field-inline-header">
                  <span>Телефон</span>
                  <div className="field-inline-tools">
                    {!showSecondPhone ? (
                      <button className="inline-icon-button" type="button" onClick={() => setShowSecondPhone(true)}>
                        +
                      </button>
                    ) : null}
                  </div>
                </div>
                <input className="action-input" value={primaryPhone} onChange={(event) => setPrimaryPhone(event.target.value)} />
                <label className="inline-radio-option">
                  <input
                    checked={primaryPhoneChoice === "phone1"}
                    name={`primary-phone-${props.client.id}`}
                    onChange={() => setPrimaryPhoneChoice("phone1")}
                    type="radio"
                  />
                  <span>Основной</span>
                </label>
              </div>

              {showSecondPhone ? (
                <div className="action-field">
                  <div className="field-inline-header">
                    <span>Телефон 2</span>
                    <div className="field-inline-tools">
                      <button
                        className="inline-icon-button is-danger"
                        type="button"
                        onClick={() => {
                          setShowSecondPhone(false);
                          setSecondPhone("");
                          setPrimaryPhoneChoice("phone1");
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <input className="action-input" value={secondPhone} onChange={(event) => setSecondPhone(event.target.value)} />
                  <label className="inline-radio-option">
                    <input
                      checked={primaryPhoneChoice === "phone2"}
                      name={`primary-phone-${props.client.id}`}
                      onChange={() => setPrimaryPhoneChoice("phone2")}
                      type="radio"
                    />
                    <span>Основной</span>
                  </label>
                </div>
              ) : null}

              {isLegalEntity ? (
                <label className="action-field">
                  <span>Контактное лицо</span>
                  <input className="action-input" value={contactPersonName} onChange={(event) => setContactPersonName(event.target.value)} />
                </label>
              ) : null}

              <label className="action-field">
                <span>Телеграмм</span>
                <input className="action-input" value={telegramHandle} onChange={(event) => setTelegramHandle(event.target.value)} />
              </label>
            </div>
          </div>
        </details>

        {canViewIdentity ? (
          <details className="client-editor-block client-section-card client-section-card-address" open>
            <summary>Адрес</summary>
            <div className="client-editor-body">
              <div className="action-field-grid">
                <label className="action-field action-field-wide">
                  <span>Фактический адрес</span>
                  <textarea
                    className="action-input action-textarea"
                    rows={3}
                    value={actualAddressFull}
                    onChange={(event) => setActualAddressFull(event.target.value)}
                    disabled={!canEditIdentity}
                  />
                </label>

                {isLegalEntity ? (
                  <label className="action-field action-field-wide">
                    <span>Комментарий к адресу</span>
                    <textarea
                      className="action-input action-textarea"
                      rows={2}
                      value={actualAddressComment}
                      onChange={(event) => setActualAddressComment(event.target.value)}
                      disabled={!canEditIdentity}
                    />
                  </label>
                ) : null}
              </div>
              {!canEditIdentity ? <p className="route-card-note">Доступ к изменению адресного блока ограничен.</p> : null}
            </div>
          </details>
        ) : null}

        <details className="client-editor-block client-section-card client-section-card-comment" open>
          <summary>Комментарий</summary>
          <div className="client-editor-body">
            <div className="action-field-grid">
              <label className="action-field action-field-wide">
                <span>Комментарий по клиенту</span>
                <textarea className="action-input action-textarea" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
              </label>
            </div>
          </div>
        </details>

        <details className="client-editor-block client-section-card client-section-card-flags" id="client-flags-block" open>
          <summary>Флаги</summary>
          <div className="client-editor-body">
            <div className="action-field-grid client-flags-grid">
              <label className={`client-flag-toggle${isProblemClient ? " is-active is-warning" : ""}`}>
                <input checked={isProblemClient} onChange={(event) => setIsProblemClient(event.target.checked)} type="checkbox" />
                <span>Проблемный клиент</span>
              </label>

              <label className={`client-flag-toggle${isThief ? " is-active is-danger" : ""}`}>
                <input checked={isThief} onChange={(event) => setIsThief(event.target.checked)} type="checkbox" />
                <span>Вор / черный список</span>
              </label>

              <label className="action-field action-field-wide">
                <span>Причина / комментарий</span>
                <textarea className="action-input action-textarea" rows={2} value={flagComment} onChange={(event) => setFlagComment(event.target.value)} />
              </label>
            </div>
          </div>
        </details>
      </div>

      <div className="inline-actions">
        <button className="action-button" type="button" disabled={!canEditClient || isPending} onClick={save}>
          {isPending ? "Сохраняю..." : "Сохранить данные клиента"}
        </button>
      </div>

      {status ? <p className="action-status is-success">{status}</p> : null}
      {error ? <p className="action-status is-error">{error}</p> : null}
      {!canEditClient ? <p className="route-card-note">Недостаточно прав для редактирования карточки клиента.</p> : null}
    </div>
  );
}
