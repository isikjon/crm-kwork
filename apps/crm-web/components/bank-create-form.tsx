"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useHasPermission } from "./auth-actor-context";

function getApiBase() {
  return process.env.NEXT_PUBLIC_CRM_API_BASE ?? "http://localhost:4200/api/v1";
}

type InstructionType = "QR" | "REQUISITES";

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.readAsDataURL(file);
  });
}

export function BankCreateForm() {
  const router = useRouter();
  const canManageBanks = useHasPermission("banks.manage");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [instructionType, setInstructionType] = useState<InstructionType>("QR");
  const [textBody, setTextBody] = useState("");
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setStatus(null);
    setError(null);

    startTransition(async () => {
      try {
        const assetFileBase64 = instructionType === "QR" && qrFile ? await readFileAsDataUrl(qrFile) : undefined;

        const response = await fetch(`${getApiBase()}/banks`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantSlug: "prokolesa",
            name: name.trim(),
            phone: phone.trim() || undefined,
            instructionType,
            assetTextBody: textBody.trim() || undefined,
            assetFileName: qrFile?.name,
            assetFileBase64
          })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
        }

        setStatus(`Банк ${payload?.bank?.name ?? name.trim()} сохранен.`);
        setName("");
        setPhone("");
        setInstructionType("QR");
        setTextBody("");
        setQrFile(null);
        router.refresh();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить банк.");
      }
    });
  }

  return (
    <article className="surface-card">
      <div className="surface-kicker">Новый банк</div>
      <h3>Что отправляем клиенту</h3>

      <div className="tariff-form-grid">
        <label className="action-field">
          <span>Название</span>
          <input
            className="action-input"
            maxLength={160}
            placeholder="Например, Сбер QR"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="action-field">
          <span>Телефон</span>
          <input
            className="action-input"
            maxLength={64}
            placeholder="Необязательно"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </label>
      </div>

      <label className="action-field">
        <span>Отправлять</span>
        <select className="action-input" value={instructionType} onChange={(event) => setInstructionType(event.target.value as InstructionType)}>
          <option value="QR">QR</option>
          <option value="REQUISITES">Реквизиты</option>
        </select>
      </label>

      <label className="action-field">
        <span>{instructionType === "QR" ? "Текст к QR" : "Текст реквизитов"}</span>
        <textarea
          className="action-input action-textarea"
          maxLength={10000}
          placeholder={instructionType === "QR" ? "Короткий текст к QR, если нужен" : "Текст, который уйдет клиенту"}
          value={textBody}
          onChange={(event) => setTextBody(event.target.value)}
        />
      </label>

      {instructionType === "QR" ? (
        <label className="action-field">
          <span>QR-картинка</span>
          <input
            className="action-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => setQrFile(event.target.files?.[0] ?? null)}
          />
        </label>
      ) : null}

      <div className="record-actions">
        <button className="action-button" disabled={!canManageBanks || isPending || name.trim().length < 2} type="button" onClick={submit}>
          {isPending ? "Сохраняю..." : "Сохранить банк"}
        </button>
      </div>

      {error ? <p className="action-status is-error">{error}</p> : null}
      {status ? <p className="action-status is-success">{status}</p> : null}
      {!canManageBanks ? <p className="route-card-note">Недостаточно прав для изменения банков и реквизитов.</p> : null}
    </article>
  );
}
