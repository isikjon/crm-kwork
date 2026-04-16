"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FinanceQueryInput, FinanceWorkspaceData } from "../lib/finance-api";
import {
  exportFinanceTransactionsCsv,
  reverseFinanceTransaction,
  setFinanceTransactionReconciled
} from "../lib/finance-api";
import { useHasPermission } from "./auth-actor-context";

function supportsReversal(transaction: FinanceWorkspaceData["registry"]["rows"][number]) {
  return transaction.type === "MANUAL_ADJUSTMENT" || transaction.type === "PENALTY_PAYMENT_IN";
}

export function FinanceRegistryToolbar(props: {
  filters: FinanceQueryInput;
  manualEntryHref?: string;
}) {
  const canExport = useHasPermission("finance.export");
  const canPostManualExpense = useHasPermission("finance.post_manual_expense");
  const canPostManualIncome = useHasPermission("finance.post_manual_income");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const canCreateManual = canPostManualExpense || canPostManualIncome;

  function handleExport() {
    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        const exported = await exportFinanceTransactionsCsv(props.filters);
        const url = URL.createObjectURL(exported.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = exported.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setStatus(`CSV выгружен: ${exported.fileName}`);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось выгрузить CSV.");
      }
    });
  }

  if (!canExport && !canCreateManual) {
    return null;
  }

  return (
    <div className="finance-toolbar-actions-group">
      <div className="finance-toolbar-actions-main">
        {canCreateManual && props.manualEntryHref ? (
          <a className="action-button is-secondary" href={props.manualEntryHref}>
            Добавить
          </a>
        ) : null}
        {canExport ? (
          <button className="action-button" type="button" onClick={handleExport} disabled={isPending}>
            {isPending ? "Экспорт..." : "Экспорт"}
          </button>
        ) : null}
      </div>
      {status ? <span className="inline-success-text">{status}</span> : null}
      {error ? <span className="inline-error-text">{error}</span> : null}
    </div>
  );
}

export function FinanceTransactionActions(props: {
  transaction: FinanceWorkspaceData["registry"]["rows"][number];
}) {
  const router = useRouter();
  const canReverseManual = useHasPermission("finance.reverse_manual");
  const canReversePenalty = useHasPermission("finance.reverse_penalty");
  const canReconcile = useHasPermission("finance.reconcile");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const canReverse = supportsReversal(props.transaction)
    && props.transaction.status === "POSTED"
    && props.transaction.correctionKind === "NONE"
    && !props.transaction.reversedByTransaction
    && (
      (props.transaction.type === "MANUAL_ADJUSTMENT" && canReverseManual)
      || (props.transaction.type === "PENALTY_PAYMENT_IN" && canReversePenalty)
    );

  function handleReverse() {
    const reason = window.prompt("Причина сторно");
    if (!reason?.trim()) {
      return;
    }

    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        await reverseFinanceTransaction({
          transactionId: props.transaction.id,
          reason
        });
        setStatus("Сторно проведено.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось выполнить сторно.");
      }
    });
  }

  function handleReconcile(nextReconciled: boolean) {
    let note: string | null = null;
    if (nextReconciled) {
      note = window.prompt("Комментарий к сверке (необязательно)")?.trim() || null;
    }

    setError(null);
    setStatus(null);

    startTransition(async () => {
      try {
        await setFinanceTransactionReconciled({
          transactionId: props.transaction.id,
          reconciled: nextReconciled,
          note
        });
        setStatus(nextReconciled ? "Операция отмечена как сверенная." : "Сверка снята.");
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось обновить статус сверки.");
      }
    });
  }

  if (!canReverse && !canReconcile) {
    return null;
  }

  return (
    <div className="finance-record-actions">
      {canReverse ? (
        <button className="inline-text-button" type="button" onClick={handleReverse} disabled={isPending}>
          Сторно
        </button>
      ) : null}
      {canReconcile ? (
        <button
          className="inline-text-button"
          type="button"
          onClick={() => handleReconcile(!props.transaction.reconciledAt)}
          disabled={isPending || props.transaction.status !== "POSTED"}
        >
          {props.transaction.reconciledAt ? "Снять сверку" : "Сверить"}
        </button>
      ) : null}
      {status ? <span className="inline-success-text">{status}</span> : null}
      {error ? <span className="inline-error-text">{error}</span> : null}
    </div>
  );
}
