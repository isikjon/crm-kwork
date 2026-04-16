import { cookies } from "next/headers";
import { loadLegacyImportDashboardData } from "../lib/legacy-api";
import { LegacyImportWorkspaceClient } from "./legacy-import-workspace-client";

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

function formatDecisionLabel(value: string) {
  switch (value) {
    case "CREATE":
      return "create";
    case "MATCH_EXISTING":
      return "match existing";
    case "SKIP":
      return "skip";
    case "FAIL":
      return "fail";
    default:
      return value;
  }
}

function formatDecisionTitle(value: string) {
  switch (value) {
    case "CREATE":
      return "Создастся";
    case "MATCH_EXISTING":
      return "Найден existing match";
    case "SKIP":
      return "Будет пропущено";
    case "FAIL":
      return "Упадет";
    default:
      return value;
  }
}

function formatMatchModeLabel(value: string) {
  switch (value) {
    case "RELIABLE":
      return "reliable";
    case "MIXED":
      return "mixed";
    case "HEURISTIC":
      return "heuristic";
    default:
      return value.toLowerCase();
  }
}

function formatMatchQualityLabel(value: string | null) {
  if (value === "RELIABLE") {
    return "reliable";
  }

  if (value === "HEURISTIC") {
    return "heuristic";
  }

  return null;
}

function formatSeverityLabel(value: string) {
  switch (value) {
    case "ERROR":
      return "error";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

function formatImportEntityLabel(value: string) {
  switch (value) {
    case "clients":
      return "Клиенты";
    case "bike_candidates_from_deals":
      return "Bike candidates";
    case "rental_deals":
      return "Аренды";
    case "buyout_deals":
      return "Выкупы";
    case "notes_and_operational_flags":
      return "Заметки и operational flags";
    case "client_enrichment":
      return "Post-import enrichment";
    default:
      return value;
  }
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

export async function LegacyImportDashboard() {
  const data = await loadLegacyImportDashboardData(cookies().toString());

  if (!data.overview) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">API bridge</div>
        <h3>Legacy import preview пока недоступен</h3>
        <p className="route-card-note">
          CRM Web не смог достучаться до CRM API по адресу <strong>{data.apiBase}</strong>.
          Когда `crm-api` будет поднят, этот экран покажет живые данные старой CRM:
          сделки, partial payments, rules и состояние файлов импорта.
        </p>
        <ul className="surface-list">
          <li>Проверь `CRM_API_INTERNAL_BASE` или `NEXT_PUBLIC_CRM_API_BASE` в `apps/crm-web/.env.local`.</li>
          <li>Проверь `LEGACY_CRM_DATA_DIR` в `apps/crm-api/.env`.</li>
          <li>Ошибка соединения: {data.error ?? "unknown error"}.</li>
        </ul>
      </section>
    );
  }

  const { overview, ordersPreview, progress, imports, latestImportDetail } = data;

  return (
    <>
      {progress ? (
        <section className="surface-card">
          <div className="surface-kicker">Текущий этап по ТЗ</div>
          <h3>
            {progress.currentStage.code} - {progress.currentStage.title}
          </h3>
          <p className="route-card-note">{progress.currentStage.summary}</p>

          <div className="target-grid">
            {progress.currentFocus.map((focus) => (
              <article className="target-card" key={focus.tzPoint + focus.label}>
                <div className="status-line">
                  <div className="route-card-title">{focus.label}</div>
                  <span>{focus.status}</span>
                </div>
                <p className="route-card-note">ТЗ: {focus.tzPoint}</p>
                <p className="route-card-note">{focus.note}</p>
              </article>
            ))}
          </div>

          <div className="stage-grid">
            {progress.stages.map((stage) => (
              <article className="stage-card" key={stage.code}>
                <div className="status-line">
                  <div className="route-card-title">{stage.code}</div>
                  <span>{stage.status}</span>
                </div>
                <h4 className="stage-title">{stage.title}</h4>
                <p className="route-card-note">{stage.summary}</p>
                <div className="stage-meta">ТЗ: {stage.tzReferences.join(", ")}</div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="metrics-grid">
        <article className="metric-card">
          <div className="metric-label">Сделки в legacy</div>
          <div className="metric-value">{overview.counts.ordersTotal}</div>
          <div className="metric-note">
            {overview.counts.activeRentals} активных аренд, {overview.counts.activeBuyouts} активных выкупов
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-label">Клиенты</div>
          <div className="metric-value">{overview.counts.uniqueClients}</div>
          <div className="metric-note">Уникальные клиенты, собранные из живого кэша сделок</div>
        </article>
        <article className="metric-card">
          <div className="metric-label">Partial cycles</div>
          <div className="metric-value">{overview.counts.partialPaymentCycles}</div>
          <div className="metric-note">
            {overview.counts.partialPaymentOrders} заказов с частичными оплатами
          </div>
        </article>
        <article className="metric-card">
          <div className="metric-label">Bike candidates</div>
          <div className="metric-value">{overview.counts.inferredBikeCandidates}</div>
          <div className="metric-note">
            Эвристически найденные product-позиции, похожие на единицы техники
          </div>
        </article>
      </section>

      <LegacyImportWorkspaceClient latestImport={latestImportDetail?.import ?? null} />

      <section className="content-grid">
        <article className="surface-card">
          <div className="surface-kicker">Legacy source</div>
          <h3>Какие файлы реально читаются</h3>
          <div className="status-grid">
            {overview.source.files.map((file) => (
              <div className="status-card" key={file.key}>
                <div className="route-card-title">{file.fileName}</div>
                <div className="status-line">
                  <strong>{file.exists ? "connected" : "missing"}</strong>
                  <span>{formatFileSize(file.bytes)}</span>
                </div>
                <div className="route-card-note">records: {file.records}</div>
                <div className="route-card-note">mode: {file.parseMode}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="surface-card">
          <div className="surface-kicker">Operational rules</div>
          <h3>Какие бизнес-правила уже подхвачены</h3>
          <ul className="surface-list">
            <li>
              `serviceDays`: {overview.rules.serviceDays.map((item) => `${item.name} (${item.days})`).join(", ") || "not found"}
            </li>
            <li>
              `buyoutPresets`: {overview.rules.buyoutPaymentPresets.map((item) => item.name).join(", ") || "not found"}
            </li>
            <li>
              `paymentDateAttribute`: {overview.rules.paymentDateAttributeName ?? "not configured"}, shiftDays = {overview.rules.shiftDays}
            </li>
            <li>
              `notifications`: due {overview.rules.notifications.dueEnabled ? "on" : "off"} / overdue {overview.rules.notifications.overdueEnabled ? "on" : "off"}
            </li>
            <li>
              `starline`: {overview.rules.starlineConfigured ? "configured in legacy" : "not configured in legacy"}
            </li>
          </ul>
        </article>
      </section>

      <section className="content-grid">
        <article className="surface-card">
          <div className="surface-kicker">Migration targets</div>
          <h3>Что новая CRM уже может вытянуть</h3>
          <div className="target-grid">
            {overview.importTargets.map((target) => (
              <div className="target-card" key={target.entity}>
                <div className="route-card-title">{target.entity}</div>
                <div className="metric-value metric-value-inline">{target.availableRecords}</div>
                <p className="route-card-note">{target.strategy}</p>
                <div className="tag-cloud">
                  <span className={`tag-chip${target.matchingMode === "HEURISTIC" ? " is-warning" : target.matchingMode === "MIXED" ? " is-neutral" : ""}`}>
                    {formatMatchModeLabel(target.matchingMode)}
                  </span>
                </div>
                <p className="route-card-note import-reliability-note">{target.reliabilityNote}</p>
                <div className="tag-cloud">
                  {target.sourceFiles.map((fileName) => (
                    <span className="tag-chip" key={fileName}>{fileName}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="surface-card">
          <div className="surface-kicker">Known gaps</div>
          <h3>Ограничения старого контура</h3>
          <ul className="surface-list">
            {overview.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="content-grid">
        <article className="surface-card">
          <div className="surface-kicker">State map</div>
          <h3>Состояние legacy-сделок</h3>
          <div className="status-grid">
            {overview.states.slice(0, 10).map((state) => (
              <div className="status-card" key={state.state}>
                <div className="route-card-title">{state.state}</div>
                <div className="metric-value metric-value-inline">{state.count}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="surface-card">
          <div className="surface-kicker">Top lines</div>
          <h3>Частые позиции старой CRM</h3>
          <ul className="surface-list">
            {overview.topServices.slice(0, 8).map((service) => (
              <li key={service.name}>
                {service.name} - {service.count}
              </li>
            ))}
          </ul>
        </article>
      </section>

      {ordersPreview ? (
        <section className="surface-card">
          <div className="surface-kicker">Live preview</div>
          <h3>Первые сделки для миграции</h3>
          <div className="target-grid">
            {ordersPreview.rows.map((order) => (
              <article className="target-card" key={order.orderId}>
                <div className="status-line">
                  <div className="route-card-title">#{order.legacyNumber}</div>
                  <span>{order.state}</span>
                </div>
                <p className="route-card-note">
                  {order.customerName ?? "Без клиента"} · {order.dealKind} · {order.dealDate ?? "no date"}
                </p>
                <ul className="surface-list compact-list">
                  <li>Сумма: {formatMoney(order.totalKopecks)}</li>
                  <li>Partial остаток: {formatMoney(order.partialPayment.outstandingKopecks)}</li>
                  <li>Заметки: {order.notesCount}</li>
                  <li>АКБ: {order.batteryCount}</li>
                </ul>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {imports?.rows.length ? (
        <section className="surface-card">
          <div className="surface-kicker">Import runs</div>
          <h3>Последние import runs и quality contour</h3>
          <div className="import-run-grid">
            {imports.rows.slice(0, 4).map((importRow) => (
              <article className="target-card import-run-card" key={importRow.id}>
                <div className="status-line">
                  <div className="route-card-title">{importRow.name}</div>
                  <span>{importRow.status}</span>
                </div>
                <p className="route-card-note">
                  {importRow.dryRun ? "dry-run" : "commit"} · jobs: {importRow.jobs.length}
                </p>
                <ul className="surface-list compact-list import-job-summary">
                  {importRow.jobs.map((job) => (
                    <li key={job.id}>
                      <strong>{formatImportEntityLabel(job.entityType)}</strong>: c {job.rowSummary.createdRows} / m {job.rowSummary.matchedRows} / w {job.rowSummary.warningRows} / f {job.rowSummary.failedRows}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="surface-card">
          <div className="surface-kicker">Import runs</div>
          <h3>Quality trail появится после первого dry-run</h3>
          <p className="route-card-note">
            После запуска `legacy/dry-run` здесь появятся import runs, разбивка `create / match / warning / fail`
            и первые row-level проблемы по quality contour.
          </p>
        </section>
      )}

      {latestImportDetail ? (
        <section className="surface-card">
          <div className="surface-kicker">Quality Trail</div>
          <h3>Последний import run по строкам</h3>
          <div className="import-diagnostic-grid">
            {latestImportDetail.import.jobs.map((job) => (
              <article className="target-card import-diagnostic-card" key={job.id}>
                <div className="status-line">
                  <div className="route-card-title">{formatImportEntityLabel(job.entityType)}</div>
                  <span>{job.status}</span>
                </div>
                <p className="route-card-note">
                  total {job.rowSummary.totalRows} · create {job.rowSummary.createdRows} · match {job.rowSummary.matchedRows} · warning {job.rowSummary.warningRows} · fail {job.rowSummary.failedRows}
                </p>
                <div className="tag-cloud">
                  <span className="tag-chip">reliable {job.rowSummary.reliableRows}</span>
                  <span className="tag-chip is-neutral">heuristic {job.rowSummary.heuristicRows}</span>
                </div>
                <ul className="surface-list compact-list import-row-list">
                  {job.rows.slice(0, 4).map((row) => (
                    <li className="import-row-card" key={row.id}>
                      <div className="status-line">
                        <strong>{formatDecisionTitle(row.decision)}</strong>
                        <span className={`tag-chip${row.severity === "ERROR" ? " is-danger" : row.severity === "WARNING" ? " is-warning" : ""}`}>
                          {formatSeverityLabel(row.severity)}
                        </span>
                      </div>
                      <div className="route-card-note import-row-title">{row.sourceRecordLabel}</div>
                      <div className="import-row-meta">
                        <span>{formatDecisionLabel(row.decision)}</span>
                        {formatMatchQualityLabel(row.matchQuality) ? (
                          <span>{formatMatchQualityLabel(row.matchQuality)}</span>
                        ) : null}
                        {row.matchedBy ? (
                          <span>{row.matchedBy}</span>
                        ) : null}
                      </div>
                      {row.issueText ? (
                        <p className="route-card-note import-row-issue">{row.issueText}</p>
                      ) : null}
                      {row.matchedEntityLabel ? (
                        <p className="route-card-note">existing: {row.matchedEntityLabel}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {job.rowSummary.warningRows > 0 || job.rowSummary.failedRows > 0 ? (
                  <p className="route-card-note import-reliability-note">
                    В этом job уже видны записи, где нужен разбор quality issues до commit/replay.
                  </p>
                ) : (
                  <p className="route-card-note import-reliability-note">
                    По этому job dry-run пока выглядит чисто: warning/fail записей в верхних строках нет.
                  </p>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : imports?.rows.length ? (
        <section className="surface-card">
          <div className="surface-kicker">Quality Trail</div>
          <h3>Row-level детали появятся после первого detail run</h3>
          <p className="route-card-note">
            Backend уже пишет row-level outcomes. Если на этом tenant пока нет detail-данных, здесь не будет
            ложной точности, только честное пустое состояние.
          </p>
        </section>
      ) : null}

      <section className="surface-card">
        <div className="surface-kicker">Следующее действие</div>
        <h3>Dry-run и commit import уже готовы на backend</h3>
        <ul className="surface-list">
          <li>`GET /api/v1/imports/progress` - отдает текущий этап проекта по ТЗ.</li>
          <li>`POST /api/v1/imports/legacy/dry-run` - создает dry-run import и import jobs в новой CRM.</li>
          <li>`POST /api/v1/imports/legacy/commit` - записывает client, bike, rental, buyout и note stubs в PostgreSQL.</li>
          <li>`POST /api/v1/imports/:importId/replay` - повторяет тот же import scope как dry-run или commit без ручной пересборки payload.</li>
          <li>`GET /api/v1/imports?tenantSlug=&lt;current-tenant&gt;` - показывает уже созданные import jobs текущего tenant.</li>
          <li>`GET /api/v1/imports/:importId?tenantSlug=&lt;current-tenant&gt;` - отдает row-level quality trail по import run.</li>
        </ul>
      </section>
    </>
  );
}
