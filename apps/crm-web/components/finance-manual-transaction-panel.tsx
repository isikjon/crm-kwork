"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FinanceWorkspaceData } from "../lib/finance-api";
import { createManualFinanceTransaction } from "../lib/finance-api";
import { useAuthActor, useHasPermission } from "./auth-actor-context";

type MoneyDirection = "INCOME" | "EXPENSE";
type PaymentMethod = "BANK" | "CASH";

function getTodayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(kopecks / 100));
}

export function FinanceManualTransactionPanel(props: {
  articles: FinanceWorkspaceData["filters"]["articles"];
  banks: FinanceWorkspaceData["filters"]["banks"];
  branches: FinanceWorkspaceData["filters"]["branches"];
  clients: FinanceWorkspaceData["filters"]["clients"];
}) {
  const router = useRouter();
  const actor = useAuthActor();
  const canPostExpense = useHasPermission("finance.post_manual_expense");
  const canPostIncome = useHasPermission("finance.post_manual_income");
  const [isPending, startTransition] = useTransition();
  const [direction, setDirection] = useState<MoneyDirection>(canPostExpense ? "EXPENSE" : "INCOME");
  const [amountRubles, setAmountRubles] = useState("");
  const [articleId, setArticleId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(props.banks.length > 0 ? "BANK" : "CASH");
  const [bankId, setBankId] = useState(props.banks[0]?.id ?? "");
  const [branchId, setBranchId] = useState("");
  const [clientId, setClientId] = useState("");
  const [happenedAt, setHappenedAt] = useState(getTodayDateInput());
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allowedDirections = useMemo(() => {
    const directions: MoneyDirection[] = [];
    if (canPostExpense) {
      directions.push("EXPENSE");
    }
    if (canPostIncome) {
      directions.push("INCOME");
    }
    return directions;
  }, [canPostExpense, canPostIncome]);

  const activeArticles = useMemo(() => (
    props.articles.filter((article) => article.isActive && article.direction === direction)
  ), [direction, props.articles]);

  const preferredBranchId = useMemo(() => {
    if (actor?.branchId && props.branches.some((branch) => branch.id === actor.branchId)) {
      return actor.branchId;
    }
    return props.branches[0]?.id ?? "";
  }, [actor?.branchId, props.branches]);

  useEffect(() => {
    if (!allowedDirections.includes(direction)) {
      setDirection(allowedDirections[0] ?? "EXPENSE");
    }
  }, [allowedDirections, direction]);

  useEffect(() => {
    if (!branchId || !props.branches.some((branch) => branch.id === branchId)) {
      setBranchId(preferredBranchId);
    }
  }, [branchId, preferredBranchId, props.branches]);

  useEffect(() => {
    if (!props.banks.some((bank) => bank.id === bankId)) {
      setBankId(props.banks[0]?.id ?? "");
    }
  }, [bankId, props.banks]);

  useEffect(() => {
    if (!articleId || !activeArticles.some((article) => article.id === articleId)) {
      setArticleId(activeArticles[0]?.id ?? "");
    }
  }, [activeArticles, articleId]);

  const amountKopecks = Math.max(0, Math.round(Number(amountRubles || "0") * 100));
  const bankRequiredButMissing = paymentMethod === "BANK" && !bankId;

  function submitManualTransaction() {
    setStatus(null);
    setError(null);

    if (!allowedDirections.length) {
      setError("У текущей роли нет прав на ручные денежные операции.");
      return;
    }

    if (!branchId) {
      setError("Выберите точку, к которой относится операция.");
      return;
    }

    if (!articleId) {
      setError("Выберите статью прихода или расхода.");
      return;
    }

    if (amountKopecks <= 0) {
      setError("Укажите сумму больше нуля.");
      return;
    }

    if (bankRequiredButMissing) {
      setError("Для банковской операции сначала выберите банк.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await createManualFinanceTransaction({
          direction,
          articleId,
          amountKopecks,
          paymentMethod,
          bankId: paymentMethod === "BANK" ? bankId : null,
          clientId: clientId || null,
          branchId,
          happenedAt: happenedAt || null,
          comment: comment.trim() || null
        }) as { transaction?: { amountKopecks?: number } };

        setAmountRubles("");
        setClientId("");
        setComment("");
        setStatus(
          `Операция проведена: ${formatMoney(response.transaction?.amountKopecks ?? amountKopecks)}. Реестр обновлен.`
        );
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось провести ручную операцию.");
      }
    });
  }

  return (
    <section className="surface-card finance-manual-card" id="finance-manual-entry">
      <div className="finance-manual-header">
        <div>
          <div className="surface-kicker">Manual Money</div>
          <h3>Новая ручная операция</h3>
          <p className="route-card-note">
            Только реальные денежные движения. Начисления и обязательства сюда не попадают.
          </p>
        </div>
        <div className="record-tags">
          <span className="tag-chip">{direction === "EXPENSE" ? "только статьи расхода" : "только статьи прихода"}</span>
          <span className="tag-chip is-neutral">архивные статьи скрыты</span>
          {paymentMethod === "BANK" ? <span className="tag-chip is-neutral">банк обязателен</span> : <span className="tag-chip is-neutral">наличные</span>}
        </div>
      </div>

      <div className="finance-manual-grid">
        <label className="action-field">
          <span>Направление</span>
          <select
            className="action-input"
            value={direction}
            onChange={(event) => setDirection(event.target.value as MoneyDirection)}
            disabled={isPending || allowedDirections.length === 0}
          >
            {canPostExpense ? <option value="EXPENSE">Расход</option> : null}
            {canPostIncome ? <option value="INCOME">Приход</option> : null}
          </select>
        </label>

        <label className="action-field finance-manual-wide">
          <span>Статья</span>
          <select
            className="action-input"
            value={articleId}
            onChange={(event) => setArticleId(event.target.value)}
            disabled={isPending || activeArticles.length === 0}
          >
            <option value="">Выберите статью</option>
            {activeArticles.map((article) => (
              <option key={article.id} value={article.id}>
                {article.name}
              </option>
            ))}
          </select>
        </label>

        <label className="action-field">
          <span>Сумма, руб.</span>
          <input
            className="action-input"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={amountRubles}
            onChange={(event) => setAmountRubles(event.target.value)}
            disabled={isPending}
          />
        </label>

        <label className="action-field">
          <span>Способ</span>
          <select
            className="action-input"
            value={paymentMethod}
            onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
            disabled={isPending}
          >
            <option value="BANK">Банк</option>
            <option value="CASH">Наличные</option>
          </select>
        </label>

        {paymentMethod === "BANK" ? (
          <label className="action-field">
            <span>Банк</span>
            <select
              className="action-input"
              value={bankId}
              onChange={(event) => setBankId(event.target.value)}
              disabled={isPending || props.banks.length === 0}
            >
              <option value="">Выберите банк</option>
              {props.banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="action-field">
          <span>Точка</span>
          <select
            className="action-input"
            value={branchId}
            onChange={(event) => setBranchId(event.target.value)}
            disabled={isPending || props.branches.length === 0}
          >
            <option value="">Выберите точку</option>
            {props.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>

        <label className="action-field">
          <span>Дата</span>
          <input
            className="action-input"
            type="date"
            value={happenedAt}
            onChange={(event) => setHappenedAt(event.target.value)}
            disabled={isPending}
          />
        </label>
      </div>

      <details className="finance-manual-optional">
        <summary>Дополнительно</summary>
        <div className="finance-manual-grid is-optional">
          <label className="action-field">
            <span>Клиент</span>
            <select
              className="action-input"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              disabled={isPending}
            >
              <option value="">Без клиента</option>
              {props.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.fullName}{client.branch ? ` · ${client.branch.name}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="action-field finance-manual-wide">
            <span>Комментарий</span>
            <textarea
              className="action-input action-textarea"
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Например: закупка расходников, доставка до точки, офисные расходы"
              disabled={isPending}
            />
          </label>
        </div>
      </details>

      {allowedDirections.length === 0 ? (
        <p className="route-card-note">У текущей роли нет прав на ручные финансовые операции.</p>
      ) : null}
      {!props.branches.length ? (
        <p className="route-card-note">В tenant пока нет точек, поэтому ручная операция недоступна.</p>
      ) : null}
      {activeArticles.length === 0 ? (
        <p className="route-card-note">Для выбранного направления нет активных статей. Сначала добавьте или верните статью из архива.</p>
      ) : null}

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}

      <div className="record-actions finance-manual-actions">
        <button
          className="action-button"
          type="button"
          onClick={submitManualTransaction}
          disabled={
            isPending
            || allowedDirections.length === 0
            || !props.branches.length
            || !articleId
            || amountKopecks <= 0
            || bankRequiredButMissing
          }
        >
          {isPending ? "Провожу..." : "Провести операцию"}
        </button>
      </div>
    </section>
  );
}
