"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useHasPermission, useTenantSlug } from "./auth-actor-context";

type PaymentMethod = "BANK" | "CASH";
const CASH_OPTION_VALUE = "__cash__";

interface DepositBankOption {
  id: string;
  name: string;
  instructionType: string;
}

interface DepositTransactionPreview {
  id: string;
  type: "DEPOSIT_IN" | "DEPOSIT_REFUND_OUT";
  paymentMethod: PaymentMethod;
  amountKopecks: number;
  happenedAt: string;
  comment: string | null;
  bank: {
    id: string;
    name: string;
  } | null;
}

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

function formatMoney(kopecks: number) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(Math.max(0, kopecks) / 100));
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "не задано";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getDepositState(params: {
  targetKopecks: number;
  collectedKopecks: number;
  returnedKopecks: number;
}) {
  const refundableKopecks = Math.max(0, params.collectedKopecks - params.returnedKopecks);

  if (params.collectedKopecks <= 0) {
    return {
      label: params.targetKopecks > 0 ? "Залог не принят" : "Залог еще не собирали",
      toneClass: "is-warning"
    };
  }

  if (refundableKopecks <= 0) {
    return {
      label: "Залог возвращен",
      toneClass: "is-success"
    };
  }

  if (params.returnedKopecks > 0) {
    return {
      label: "Залог возвращен частично",
      toneClass: "is-warning"
    };
  }

  if (params.targetKopecks > 0 && params.collectedKopecks < params.targetKopecks) {
    return {
      label: "Залог собран не полностью",
      toneClass: "is-warning"
    };
  }

  return {
    label: "Залог принят",
    toneClass: "is-success"
  };
}

function formatMethodLabel(method: PaymentMethod, bankName?: string | null) {
  if (method === "BANK") {
    return bankName ? `Перевод · ${bankName}` : "Перевод";
  }

  return "Наличные";
}

function formatTransactionLabel(type: DepositTransactionPreview["type"]) {
  return type === "DEPOSIT_IN" ? "Принят залог" : "Возврат залога";
}

function resolvePaymentTarget(value: string) {
  if (value === CASH_OPTION_VALUE) {
    return {
      paymentMethod: "CASH" as const,
      bankId: ""
    };
  }

  return {
    paymentMethod: "BANK" as const,
    bankId: value
  };
}

export function RentalDepositAction(props: {
  rentalId: string;
  availableBanks: DepositBankOption[];
  depositTargetKopecks: number;
  depositCollectedKopecks: number;
  depositReturnedKopecks: number;
  depositTransactions?: DepositTransactionPreview[];
  onCompleted?: () => void;
}) {
  const router = useRouter();
  const tenantSlug = useTenantSlug();
  const canReceiveDeposit = useHasPermission("rentals.receive_deposit");
  const canRefundDeposit = useHasPermission("rentals.refund_deposit");
  const [isPending, startTransition] = useTransition();
  const [receiveRubles, setReceiveRubles] = useState("0");
  const [refundRubles, setRefundRubles] = useState("0");
  const [receiveMethod, setReceiveMethod] = useState<PaymentMethod>("CASH");
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>("CASH");
  const [receiveBankId, setReceiveBankId] = useState("");
  const [refundBankId, setRefundBankId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remainingToCollect = Math.max(0, props.depositTargetKopecks - props.depositCollectedKopecks);
  const availableToRefund = Math.max(0, props.depositCollectedKopecks - props.depositReturnedKopecks);
  const depositState = getDepositState({
    targetKopecks: props.depositTargetKopecks,
    collectedKopecks: props.depositCollectedKopecks,
    returnedKopecks: props.depositReturnedKopecks
  });
  const recentTransactions = props.depositTransactions?.slice(0, 4) ?? [];

  useEffect(() => {
    setReceiveRubles(remainingToCollect > 0 ? String(Math.round(remainingToCollect / 100)) : "0");
    setRefundRubles(availableToRefund > 0 ? String(Math.round(availableToRefund / 100)) : "0");
    setReceiveMethod("CASH");
    setRefundMethod("CASH");
    setReceiveBankId("");
    setRefundBankId("");
  }, [availableToRefund, remainingToCollect]);

  const receiveTargetValue = receiveMethod === "BANK" ? receiveBankId : CASH_OPTION_VALUE;
  const refundTargetValue = refundMethod === "BANK" ? refundBankId : CASH_OPTION_VALUE;

  function submit(mode: "receive" | "refund") {
    // Deposit collect and refund are separate finance facts, so the card always posts them as distinct backend operations.
    setError(null);
    setStatus(null);

    const amountKopecks = Math.max(0, Math.round(Number((mode === "receive" ? receiveRubles : refundRubles) || "0") * 100));
    const paymentMethod = mode === "receive" ? receiveMethod : refundMethod;
    const selectedBankId = mode === "receive" ? receiveBankId : refundBankId;
    const selectedBank = selectedBankId
      ? props.availableBanks.find((bank) => bank.id === selectedBankId) ?? null
      : null;

    if (amountKopecks <= 0) {
      setError("Укажите сумму больше нуля.");
      return;
    }

    if (mode === "refund" && amountKopecks > availableToRefund) {
      setError("Сумма возврата превышает доступный остаток залога.");
      return;
    }

    if (paymentMethod === "BANK" && !selectedBankId) {
      setError("Для перевода выберите банк из раздела «Банки».");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch(`${getApiBase()}/rentals/${props.rentalId}/deposits/${mode === "receive" ? "receive" : "refund"}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug,
            amountKopecks,
            paymentMethod,
            bankId: paymentMethod === "BANK" ? selectedBankId : undefined,
            comment: mode === "receive"
              ? "Принят залог из сделки"
              : "Возврат залога из сделки"
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(
          mode === "receive"
            ? `Залог принят${paymentMethod === "BANK" && selectedBank ? ` через ${selectedBank.name}` : ""}.`
            : `Залог возвращен${paymentMethod === "BANK" && selectedBank ? ` через ${selectedBank.name}` : " наличными"}.`
        );

        if (props.onCompleted) {
          props.onCompleted();
        } else {
          router.refresh();
        }
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Операция по залогу не удалась.");
      }
    });
  }

  return (
    <article className="surface-card rental-deposit-card">
      <div className="rental-deposit-head">
        <div>
          <div className="surface-kicker">Залог</div>
          <h3>Состояние залога</h3>
        </div>
        <span className={`tag-chip rental-deposit-state ${depositState.toneClass}`}>{depositState.label}</span>
      </div>

      <div className="record-tags rental-deposit-metrics">
        <span className="tag-chip">цель: {formatMoney(props.depositTargetKopecks)} руб.</span>
        <span className="tag-chip">принято: {formatMoney(props.depositCollectedKopecks)} руб.</span>
        <span className="tag-chip">возвращено: {formatMoney(props.depositReturnedKopecks)} руб.</span>
        <span className="tag-chip">доступно к возврату: {formatMoney(availableToRefund)} руб.</span>
      </div>

      <div className="rental-deposit-grid">
        <section className="rental-deposit-panel">
          <div className="surface-kicker">Принять</div>
          <h4>Принять залог</h4>
          <p className="route-card-note">
            Принятый залог сразу отразится в финансовом контуре сделки.
          </p>

          <div className="action-field-grid">
            <label className="action-field">
              <span>Сумма, руб.</span>
              <input
                className="action-input"
                inputMode="numeric"
                min={0}
                step={1}
                type="number"
                value={receiveRubles}
                onChange={(event) => setReceiveRubles(event.target.value)}
              />
            </label>

            <label className="action-field">
              <span>Куда принять</span>
              <select
                className="action-input"
                value={receiveTargetValue}
                onChange={(event) => {
                  const target = resolvePaymentTarget(event.target.value);
                  setReceiveMethod(target.paymentMethod);
                  setReceiveBankId(target.bankId);
                }}
              >
                <option value={CASH_OPTION_VALUE}>Наличные</option>
                {props.availableBanks.map((bank) => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="record-actions">
            <button className="action-button" disabled={!canReceiveDeposit || isPending} type="button" onClick={() => submit("receive")}>
              {isPending ? "Обрабатываю..." : "Принять залог"}
            </button>
          </div>
        </section>

        <section className="rental-deposit-panel">
          <div className="surface-kicker">Вернуть</div>
          <h4>Вернуть залог</h4>
          <p className="route-card-note">
            Возврат переводом спишется только с выбранного банка CRM и сразу попадет в финансы сделки.
          </p>

          <div className="action-field-grid">
            <label className="action-field">
              <span>Сумма возврата, руб.</span>
              <input
                className="action-input"
                inputMode="numeric"
                min={0}
                step={1}
                type="number"
                value={refundRubles}
                onChange={(event) => setRefundRubles(event.target.value)}
              />
            </label>

            <label className="action-field">
              <span>Куда вернуть</span>
              <select
                className="action-input"
                value={refundTargetValue}
                onChange={(event) => {
                  const target = resolvePaymentTarget(event.target.value);
                  setRefundMethod(target.paymentMethod);
                  setRefundBankId(target.bankId);
                }}
              >
                <option value={CASH_OPTION_VALUE}>Наличные</option>
                {props.availableBanks.map((bank) => (
                  <option key={bank.id} value={bank.id}>{bank.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="record-actions">
            <button
              className="action-button"
              disabled={!canRefundDeposit || isPending || availableToRefund <= 0}
              type="button"
              onClick={() => submit("refund")}
            >
              {isPending ? "Обрабатываю..." : "Вернуть залог"}
            </button>
          </div>
        </section>
      </div>

      {recentTransactions.length > 0 ? (
        <div className="rental-deposit-history">
          <strong className="orders-inline-section-title">Последние операции по залогу</strong>
          <div className="orders-expand-inline-list is-compact">
            {recentTransactions.map((transaction) => (
              <div className="orders-expand-inline-row is-compact" key={transaction.id}>
                <strong>{formatTransactionLabel(transaction.type)}</strong>
                <span>{formatMoney(transaction.amountKopecks)} руб.</span>
                <span>{formatMethodLabel(transaction.paymentMethod, transaction.bank?.name)}</span>
                <span>{formatDateTime(transaction.happenedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {props.availableBanks.length === 0 ? (
        <p className="route-card-note">В разделе «Банки» пока нет активных банков. Перевод будет недоступен.</p>
      ) : null}

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canReceiveDeposit || !canRefundDeposit ? (
        <p className="route-card-note">
          {!canReceiveDeposit && !canRefundDeposit
            ? "Недостаточно прав для операций по залогу."
            : !canReceiveDeposit
              ? "Недостаточно прав для приема залога."
              : "Недостаточно прав для возврата залога."}
        </p>
      ) : null}
    </article>
  );
}
