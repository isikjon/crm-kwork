"use client";

import { useEffect, useMemo, useState } from "react";
import { bootstrapTenantOwner, fetchAuthStatus, loginWithPassword } from "../lib/auth-api";
import { rememberTenantSlugBrowser } from "../lib/tenant";

export function LoginForm(props: {
  initialTenantSlug: string;
}) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchAuthStatus>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenantSlug, setTenantSlug] = useState(props.initialTenantSlug);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    const normalizedTenantSlug = tenantSlug.trim();
    if (normalizedTenantSlug.length < 2) {
      setStatus(null);
      setError("Укажите tenant slug.");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);

    const timeoutId = window.setTimeout(() => {
      void fetchAuthStatus(normalizedTenantSlug)
        .then((payload) => {
          if (!cancelled) {
            setStatus(payload);
          }
        })
        .catch((loadError: unknown) => {
          if (!cancelled) {
            setStatus(null);
            setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить auth-статус");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [tenantSlug]);

  const requiresBootstrap = status?.requiresBootstrap ?? false;
  const title = useMemo(() => (
    requiresBootstrap ? "Первичная настройка владельца" : "Вход в CRM"
  ), [requiresBootstrap]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      if (requiresBootstrap) {
        if (password !== confirmPassword) {
          throw new Error("Пароль и подтверждение не совпадают");
        }

        await bootstrapTenantOwner({
          tenantSlug: tenantSlug.trim(),
          fullName,
          email,
          password
        });
      } else {
        await loginWithPassword({
          tenantSlug: tenantSlug.trim(),
          email,
          password
        });
      }

      rememberTenantSlugBrowser(tenantSlug.trim());
      window.location.href = "/";
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Не удалось выполнить действие");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-card-eyebrow">Security Contour</div>
        <h1 className="auth-card-title">{title}</h1>
        <p className="auth-card-summary">
          {requiresBootstrap
            ? "Сначала создаем владельца tenant и безопасно поднимаем первый контур доступа."
            : "Войдите под своей учетной записью, чтобы открыть рабочие модули CRM."}
        </p>

        <div className="auth-status-strip">
          <div>
            <div className="auth-status-strip-label">Tenant</div>
            <div className="auth-status-strip-value">{status?.tenant.name ?? tenantSlug.toUpperCase()}</div>
          </div>
          <div>
            <div className="auth-status-strip-label">Сценарий</div>
            <div className="auth-status-strip-value">{requiresBootstrap ? "Bootstrap owner" : "Login"}</div>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Tenant slug</span>
            <input
              type="text"
              value={tenantSlug}
              onChange={(event) => setTenantSlug(event.target.value)}
              placeholder="Например, staging-review"
              autoComplete="organization"
              required
            />
          </label>

          {loading ? (
            <div className="auth-message-card">Проверяем статус авторизации и bootstrap...</div>
          ) : (
            <>
              {requiresBootstrap ? (
                <label className="auth-field">
                  <span>Имя владельца</span>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    placeholder="Например, Основатель ПРОКОЛЕСА"
                    required
                  />
                </label>
              ) : null}

              <label className="auth-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="owner@tenant.local"
                  autoComplete="username"
                  required
                />
              </label>

              <label className="auth-field">
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Минимум 8 символов"
                  autoComplete={requiresBootstrap ? "new-password" : "current-password"}
                  required
                />
              </label>

              {requiresBootstrap ? (
                <label className="auth-field">
                  <span>Подтверждение пароля</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Повторите пароль"
                    autoComplete="new-password"
                    required
                  />
                </label>
              ) : null}

              {error ? <div className="auth-error-banner">{error}</div> : null}

              <button className="auth-submit-button" type="submit" disabled={submitting}>
                {submitting
                  ? (requiresBootstrap ? "Создаем владельца..." : "Входим...")
                  : (requiresBootstrap ? "Создать владельца и войти" : "Войти")}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
