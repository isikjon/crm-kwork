"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { FinanceWorkspaceData } from "../lib/finance-api";
import { createFinanceArticle, updateFinanceArticle } from "../lib/finance-api";
import { useHasPermission } from "./auth-actor-context";

function splitArticlesByDirection(articles: FinanceWorkspaceData["filters"]["articles"]) {
  return {
    income: articles.filter((article) => article.direction === "INCOME"),
    expense: articles.filter((article) => article.direction === "EXPENSE")
  };
}

export function FinanceArticlesManager(props: {
  articles: FinanceWorkspaceData["filters"]["articles"];
}) {
  const router = useRouter();
  const canManageArticles = useHasPermission("finance.manage_articles");
  const [isPending, startTransition] = useTransition();
  const [direction, setDirection] = useState<"INCOME" | "EXPENSE">("EXPENSE");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const grouped = useMemo(() => splitArticlesByDirection(props.articles), [props.articles]);

  function setDraft(articleId: string, value: string) {
    setDrafts((current) => ({
      ...current,
      [articleId]: value
    }));
  }

  function runRequest(run: () => Promise<void>) {
    setStatus(null);
    setError(null);
    startTransition(async () => {
      try {
        await run();
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "Операция не выполнена.");
      }
    });
  }

  function handleCreateArticle() {
    runRequest(async () => {
      const created = await createFinanceArticle({
        direction,
        name
      });
      setName("");
      setStatus(`Статья «${(created as { article: { name: string } }).article.name}» добавлена.`);
      router.refresh();
    });
  }

  function handleUpdateArticle(articleId: string, nextName: string, isActive?: boolean) {
    runRequest(async () => {
      await updateFinanceArticle({
        articleId,
        name: nextName,
        ...(isActive == null ? {} : { isActive })
      });
      setStatus("Статья обновлена.");
      router.refresh();
    });
  }

  return (
    <section className="surface-card finance-articles-card">
      <div className="surface-kicker">Finance Articles</div>
      <h3>Статьи прихода и расхода</h3>
      <p className="route-card-note">
        Статьи tenant-level живут отдельно от системного `TransactionType`. История операций не ломается:
        выключенные статьи остаются в реестре и фильтрах.
      </p>

      <div className="finance-article-create">
        <label className="action-field">
          <span>Направление</span>
          <select
            className="action-input"
            value={direction}
            onChange={(event) => setDirection(event.target.value as "INCOME" | "EXPENSE")}
            disabled={!canManageArticles || isPending}
          >
            <option value="INCOME">Приход</option>
            <option value="EXPENSE">Расход</option>
          </select>
        </label>
        <label className="action-field finance-article-create-name">
          <span>Новая статья</span>
          <input
            className="action-input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Например, Доставка до точки"
            disabled={!canManageArticles || isPending}
          />
        </label>
        <button
          className="action-button"
          type="button"
          onClick={handleCreateArticle}
          disabled={!canManageArticles || isPending || name.trim().length < 2}
        >
          Добавить статью
        </button>
      </div>

      {status ? <p className="orders-expand-note">{status}</p> : null}
      {error ? <p className="orders-expand-error">{error}</p> : null}
      {!canManageArticles ? (
        <p className="orders-expand-note is-muted">
          У текущей роли нет права `finance.manage_articles`, поэтому каталог доступен только для просмотра.
        </p>
      ) : null}

      <div className="finance-articles-grid">
        {[
          { title: "Статьи прихода", rows: grouped.income },
          { title: "Статьи расхода", rows: grouped.expense }
        ].map((group) => (
          <article className="finance-article-group" key={group.title}>
            <div className="finance-article-group-head">
              <strong>{group.title}</strong>
              <span>{group.rows.length}</span>
            </div>

            <div className="finance-article-list">
              {group.rows.map((article) => {
                const draftValue = drafts[article.id] ?? article.name;

                return (
                  <div className={`finance-article-row${article.isActive ? "" : " is-archived"}`} key={article.id}>
                    <div className="finance-article-row-main">
                      <div className="finance-article-row-head">
                        <strong>{article.name}</strong>
                        <div className="record-tags">
                          <span className={`tag-chip${article.isActive ? "" : " is-neutral"}`}>
                            {article.isActive ? "Активна" : "Архив"}
                          </span>
                          {article.isSystem ? <span className="tag-chip">Системная</span> : null}
                          <span className="tag-chip is-neutral">{article._count.transactions} оп.</span>
                        </div>
                      </div>

                      <div className="finance-article-inline-edit">
                        <input
                          className="action-input"
                          type="text"
                          value={draftValue}
                          onChange={(event) => setDraft(article.id, event.target.value)}
                          disabled={!canManageArticles || isPending}
                        />
                        <button
                          className="inline-text-button"
                          type="button"
                          onClick={() => handleUpdateArticle(article.id, draftValue)}
                          disabled={!canManageArticles || isPending || draftValue.trim().length < 2 || draftValue.trim() === article.name}
                        >
                          Переименовать
                        </button>
                        <button
                          className={`inline-text-button${article.isActive ? "" : " is-danger"}`}
                          type="button"
                          onClick={() => handleUpdateArticle(article.id, draftValue, !article.isActive)}
                          disabled={!canManageArticles || isPending}
                        >
                          {article.isActive ? "В архив" : "Вернуть"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
