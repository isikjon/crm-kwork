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

type RelativeDraft = {
  id: string;
  fullName: string;
  phone: string;
  comment: string;
};

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function draftId() {
  return `draft-${Math.random().toString(36).slice(2, 10)}`;
}

export function ClientCreateForm(props: {
  workplaces: WorkplaceRow[];
}) {
  const router = useRouter();
  const canEditClient = useHasPermission("clients.edit");
  const [isPending, startTransition] = useTransition();

  const [workplaceOptions, setWorkplaceOptions] = useState(props.workplaces);
  const [clientType, setClientType] = useState<"INDIVIDUAL" | "LEGAL_ENTITY">("INDIVIDUAL");
  const [showWorkplaceManager, setShowWorkplaceManager] = useState(false);
  const [workplaceQuery, setWorkplaceQuery] = useState("");
  const [newWorkplaceLabel, setNewWorkplaceLabel] = useState("");
  const [selectedOptionId, setSelectedOptionId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [courierId, setCourierId] = useState("");
  const [taxId, setTaxId] = useState("");
  const [kpp, setKpp] = useState("");
  const [ogrn, setOgrn] = useState("");
  const [contactPersonName, setContactPersonName] = useState("");
  const [lastName, setLastName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [middleName, setMiddleName] = useState("");
  const [primaryPhone, setPrimaryPhone] = useState("");
  const [showSecondPhone, setShowSecondPhone] = useState(false);
  const [secondPhone, setSecondPhone] = useState("");
  const [primaryPhoneChoice, setPrimaryPhoneChoice] = useState<"phone1" | "phone2">("phone1");
  const [telegramHandle, setTelegramHandle] = useState("");
  const [actualAddressFull, setActualAddressFull] = useState("");
  const [actualAddressComment, setActualAddressComment] = useState("");
  const [comment, setComment] = useState("");
  const [isProblemClient, setIsProblemClient] = useState(false);
  const [isThief, setIsThief] = useState(false);
  const [flagComment, setFlagComment] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [passportSeries, setPassportSeries] = useState("");
  const [passportNumber, setPassportNumber] = useState("");
  const [issuedBy, setIssuedBy] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [relativeFullName, setRelativeFullName] = useState("");
  const [relativePhone, setRelativePhone] = useState("");
  const [relativeComment, setRelativeComment] = useState("");
  const [relativeDrafts, setRelativeDrafts] = useState<RelativeDraft[]>([]);
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

  function buildFullName() {
    if (isLegalEntity) {
      return companyName.trim();
    }

    return [lastName.trim(), firstName.trim(), middleName.trim()].filter(Boolean).join(" ");
  }

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

  function addRelativeDraft() {
    setStatus(null);
    setError(null);

    if (!relativeFullName.trim() || !relativePhone.trim()) {
      setError("Укажите имя и телефон родственника.");
      return;
    }

    setRelativeDrafts((current) => [
      ...current,
      {
        id: draftId(),
        fullName: relativeFullName.trim(),
        phone: relativePhone.trim(),
        comment: relativeComment.trim()
      }
    ]);
    setRelativeFullName("");
    setRelativePhone("");
    setRelativeComment("");
  }

  function removeRelativeDraft(id: string) {
    setRelativeDrafts((current) => current.filter((row) => row.id !== id));
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

  function submit() {
    setStatus(null);
    setError(null);

    const fullName = buildFullName();
    if (!fullName) {
      setError(isLegalEntity ? "Укажите название клиента." : "Заполните фамилию, имя или отчество.");
      return;
    }

    startTransition(async () => {
      let createdClientId: string | null = null;

      try {
        const tenantSlug = getCurrentTenantSlugBrowser();
        const phoneContacts = buildPhoneContacts();
        const primaryPhoneValue = phoneContacts.find((row) => row.isPrimary)?.value ?? phoneContacts[0]?.value ?? null;

        const createResponse = await fetch(`${getApiBase()}/clients`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            fullName,
            clientType,
            primaryPhone: primaryPhoneValue,
            telegramHandle: telegramHandle.trim() || null,
            lastName: isLegalEntity ? null : lastName.trim() || null,
            firstName: isLegalEntity ? null : firstName.trim() || null,
            middleName: isLegalEntity ? null : middleName.trim() || null,
            comment: comment.trim() || null,
            isProblemClient,
            isThief,
            flagComment: flagComment.trim() || null
          })
        });

        const createPayload = await createResponse.json().catch(() => null);
        if (!createResponse.ok) {
          throw new Error(createPayload?.error?.message ?? `Request failed with ${createResponse.status}`);
        }

        createdClientId = createPayload?.client?.id ?? null;
        if (!createdClientId) {
          throw new Error("Не удалось получить ID клиента после создания.");
        }

        const patchResponse = await fetch(`${getApiBase()}/clients/${createdClientId}/profile`, {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            clientType,
            fullName: isLegalEntity ? fullName : null,
            workplaceOptionId: selectedOptionId || null,
            clearWorkplace: !selectedOptionId,
            courierId,
            taxId,
            kpp,
            ogrn,
            primaryPhone: primaryPhoneValue,
            phoneContacts,
            contactPersonName,
            telegramHandle,
            lastName: isLegalEntity ? null : lastName,
            firstName: isLegalEntity ? null : firstName,
            middleName: isLegalEntity ? null : middleName,
            passportSeries,
            passportNumber,
            issuedBy,
            issuedAt,
            departmentCode,
            birthDate,
            actualAddressFull,
            actualAddressComment: isLegalEntity ? actualAddressComment : null,
            comment,
            isProblemClient,
            isThief,
            flagComment
          })
        });

        const patchPayload = await patchResponse.json().catch(() => null);
        if (!patchResponse.ok) {
          throw new Error(patchPayload?.error?.message ?? `Request failed with ${patchResponse.status}`);
        }

        for (const relative of relativeDrafts) {
          const relativeResponse = await fetch(`${getApiBase()}/clients/${createdClientId}/relatives`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              tenantSlug,
              fullName: relative.fullName,
              phone: relative.phone,
              comment: relative.comment || null
            })
          });

          const relativePayload = await relativeResponse.json().catch(() => null);
          if (!relativeResponse.ok) {
            throw new Error(relativePayload?.error?.message ?? `Request failed with ${relativeResponse.status}`);
          }
        }

        router.push(createPayload?.detailHref ?? `/clients/${createdClientId}`);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось создать клиента.");
      }
    });
  }

  return (
    <div className="client-page-shell">
      <section className="surface-card client-page-panel">
        <a className="detail-back-link" href="/clients">
          {"<-"} Назад к списку клиентов
        </a>

        <div className="client-page-head">
          <div>
            <div className="surface-kicker">Новый клиент</div>
            <h3>Создать клиента</h3>
            <p className="route-card-note">
              Форма собрана так же, как обычная карточка клиента.
            </p>
          </div>
        </div>
      </section>

      <div className="client-detail-layout">
        <div className="client-side-stack">
          {!isLegalEntity ? (
            <section className="surface-card client-side-panel">
              <div className="surface-kicker">Паспорт</div>
              <h3>Паспортные данные</h3>
              <div className="action-card client-form-card is-compact">
                <details className="client-editor-block" open>
                  <summary>Паспорт</summary>
                  <div className="client-editor-body">
                    <div className="action-field-grid">
                      <label className="action-field">
                        <span>Дата рождения</span>
                        <input className="action-input" type="date" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>Серия</span>
                        <input className="action-input" value={passportSeries} onChange={(event) => setPassportSeries(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>№</span>
                        <input className="action-input" value={passportNumber} onChange={(event) => setPassportNumber(event.target.value)} />
                      </label>

                      <label className="action-field action-field-wide">
                        <span>Где выдан</span>
                        <input className="action-input" value={issuedBy} onChange={(event) => setIssuedBy(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>Дата выдачи</span>
                        <input className="action-input" type="date" value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} />
                      </label>

                      <label className="action-field">
                        <span>Код подразделения</span>
                        <input className="action-input" value={departmentCode} onChange={(event) => setDepartmentCode(event.target.value)} />
                      </label>
                    </div>
                  </div>
                </details>
              </div>
            </section>
          ) : null}

          <section className="surface-card client-side-panel">
            <div className="surface-kicker">Контакты доверия</div>
            <h3>Родственники</h3>
            <div className="action-card client-form-card is-compact">
              <details className="client-editor-block" open>
                <summary>Родственники</summary>
                <div className="client-editor-body">
                  <div className="action-field-grid">
                    <label className="action-field">
                      <span>Кто это</span>
                      <input className="action-input" value={relativeFullName} onChange={(event) => setRelativeFullName(event.target.value)} />
                    </label>

                    <label className="action-field">
                      <span>Телефон</span>
                      <input className="action-input" value={relativePhone} onChange={(event) => setRelativePhone(event.target.value)} />
                    </label>

                    <label className="action-field action-field-wide">
                      <span>Комментарий</span>
                      <textarea className="action-input action-textarea" rows={2} value={relativeComment} onChange={(event) => setRelativeComment(event.target.value)} />
                    </label>
                  </div>

                  <div className="inline-actions">
                    <button className="action-button" disabled={!canEditClient} type="button" onClick={addRelativeDraft}>
                      Добавить родственника
                    </button>
                  </div>

                  {relativeDrafts.length > 0 ? (
                    <div className="lookup-list">
                      {relativeDrafts.map((relative) => (
                        <div className="lookup-list-row" key={relative.id}>
                          <span className="lookup-list-marker" aria-hidden="true" />
                          <div className="lookup-list-label">
                            <strong>{relative.fullName}</strong>
                            <div className="route-card-note">{relative.phone}{relative.comment ? ` · ${relative.comment}` : ""}</div>
                          </div>
                          <button className="lookup-list-delete" disabled={!canEditClient} type="button" onClick={() => removeRelativeDraft(relative.id)}>
                            Удалить
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="route-card-note">Пока родственники не добавлены.</p>
                  )}
                </div>
              </details>
            </div>
          </section>
        </div>

        <section className="surface-card client-page-panel-form client-main-panel">
          <div className="surface-kicker">Данные клиента</div>
          <h3>Карточка клиента</h3>

          <div className="action-card client-form-card is-compact">
            <div className="client-form-sections">
              <details className="client-editor-block client-section-card is-main" open>
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
                          <input className="action-input" value={companyName} onChange={(event) => setCompanyName(event.target.value)} />
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
                              <button className="inline-icon-button" type="button" onClick={() => setShowWorkplaceManager((current) => !current)}>
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
                                <input className="action-input" placeholder="Новое место работы" value={newWorkplaceLabel} onChange={(event) => setNewWorkplaceLabel(event.target.value)} />
                                <button className="inline-text-button" disabled={!canEditClient || isPending} type="button" onClick={addWorkplace}>
                                  Сохранить
                                </button>
                              </div>
                              <input className="action-input mini-lookup-search" placeholder="Найти значение" value={workplaceQuery} onChange={(event) => setWorkplaceQuery(event.target.value)} />
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

              <details className="client-editor-block client-section-card" open>
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
                        <input checked={primaryPhoneChoice === "phone1"} name="create-primary-phone" onChange={() => setPrimaryPhoneChoice("phone1")} type="radio" />
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
                          <input checked={primaryPhoneChoice === "phone2"} name="create-primary-phone" onChange={() => setPrimaryPhoneChoice("phone2")} type="radio" />
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

              <details className="client-editor-block client-section-card" open>
                <summary>Адрес</summary>
                <div className="client-editor-body">
                  <div className="action-field-grid">
                    <label className="action-field action-field-wide">
                      <span>Фактический адрес</span>
                      <textarea className="action-input action-textarea" rows={3} value={actualAddressFull} onChange={(event) => setActualAddressFull(event.target.value)} />
                    </label>

                    {isLegalEntity ? (
                      <label className="action-field action-field-wide">
                        <span>Комментарий к адресу</span>
                        <textarea className="action-input action-textarea" rows={2} value={actualAddressComment} onChange={(event) => setActualAddressComment(event.target.value)} />
                      </label>
                    ) : null}
                  </div>
                </div>
              </details>

              <details className="client-editor-block client-section-card" open>
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

              <details className="client-editor-block client-section-card" open>
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
              <button className="action-button" disabled={!canEditClient || isPending} onClick={submit} type="button">
                {isPending ? "Создаю..." : "Создать клиента"}
              </button>
              <a className="detail-back-link" href="/clients">
                Отмена
              </a>
            </div>

            {status ? <p className="action-status is-success">{status}</p> : null}
            {error ? <p className="action-status is-error">{error}</p> : null}
            {!canEditClient ? <p className="route-card-note">Недостаточно прав для создания и редактирования клиентов.</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
