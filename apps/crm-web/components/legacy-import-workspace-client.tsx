"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";
import type { LegacyImportDetailView } from "../lib/legacy-api";
import { getCurrentTenantSlugBrowser } from "../lib/tenant";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatImportEntityLabel(entityType: string) {
  switch (entityType) {
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
      return entityType;
  }
}

export function LegacyImportWorkspaceClient(props: {
  latestImport: LegacyImportDetailView["import"] | null;
}) {
  const router = useRouter();
  const canRunImports = useHasPermission("imports.run");
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function readJsonError(response: Response) {
    const payload = await response.json().catch(() => null);
    return payload?.error?.message ?? `Request failed with ${response.status}`;
  }

  function runRequest(run: () => Promise<string>) {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const message = await run();
        setStatus(message);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Операция не выполнена.");
      }
    });
  }

  function runDryRun() {
    runRequest(async () => {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const response = await fetch(`${getApiBase()}/imports/legacy/dry-run`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      return "Dry-run запущен. Экран обновлен новым quality preview.";
    });
  }

  function replayImport(dryRun: boolean) {
    const latestImport = props.latestImport;
    if (!latestImport) {
      setError("Сначала нужен хотя бы один import run.");
      setStatus(null);
      return;
    }

    runRequest(async () => {
      const tenantSlug = getCurrentTenantSlugBrowser();
      const response = await fetch(`${getApiBase()}/imports/${latestImport.id}/replay`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          tenantSlug,
          dryRun
        })
      });

      if (!response.ok) {
        throw new Error(await readJsonError(response));
      }

      if (dryRun) {
        return "Replay dry-run запущен по тому же import scope.";
      }

      return latestImport.dryRun
        ? "Commit запущен по последнему dry-run."
        : "Replay commit запущен по последнему import run.";
    });
  }

  const latestCoreJobs = props.latestImport?.jobs.filter((job) => job.entityType !== "client_enrichment") ?? [];
  const latestFailedJobs = props.latestImport?.jobs.filter((job) => job.failedRows > 0).length ?? 0;
  const latestWarningJobs = props.latestImport?.jobs.filter((job) => job.rowSummary.warningRows > 0).length ?? 0;

  return (
    <section className="surface-card">
      <div className="surface-kicker">Operator flow</div>
      <h3>Dry-run, commit и безопасный replay</h3>
      <p className="route-card-note">
        Сначала quality preview, потом commit, затем при необходимости safe replay по тому же scope.
        Повторный запуск не должен плодить дубли, потому что commit идет через stable legacy keys и row-level outcomes.
      </p>

      <div className="import-action-row">
        <button className="action-button" disabled={!canRunImports || isPending} type="button" onClick={runDryRun}>
          Запустить dry-run
        </button>
        <button
          className="action-button is-secondary"
          disabled={!canRunImports || isPending || !props.latestImport}
          type="button"
          onClick={() => replayImport(false)}
        >
          {props.latestImport?.dryRun ? "Commit по последнему dry-run" : "Replay последнего import"}
        </button>
        <button
          className="action-button is-secondary"
          disabled={!canRunImports || isPending || !props.latestImport}
          type="button"
          onClick={() => replayImport(true)}
        >
          Повторить dry-run по тому же scope
        </button>
      </div>

      {!canRunImports ? (
        <p className="route-card-note">Запуск dry-run и replay доступен только роли с правом `imports.run`.</p>
      ) : null}

      {props.latestImport ? (
        <div className="import-stage-list">
          <div className="status-line">
            <strong>Последний run</strong>
            <span>{props.latestImport.status}</span>
          </div>
          <p className="route-card-note">
            {props.latestImport.dryRun ? "dry-run" : "commit"} · jobs: {props.latestImport.jobs.length} · warning jobs: {latestWarningJobs} · failed jobs: {latestFailedJobs}
          </p>
          <div className="tag-cloud">
            {latestCoreJobs.map((job) => (
              <span className="tag-chip" key={job.id}>
                {formatImportEntityLabel(job.entityType)}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="route-card-note">После первого dry-run здесь появится текущий import scope и быстрые replay-действия.</p>
      )}

      {status ? <p className="route-card-note import-stage-note">{status}</p> : null}
      {error ? <p className="route-card-note import-stage-note is-error">{error}</p> : null}
    </section>
  );
}
