import { NAV_ITEMS } from "../../lib/site-data";

const heroMetrics = [
  { label: "Активные аренды", value: "128", note: "9 просрочек требуют внимания" },
  { label: "Активные выкупы", value: "41", note: "7 платежей сегодня" },
  { label: "Свободные велосипеды", value: "63", note: "12 готовы к выдаче сегодня" },
  { label: "Ремонтный фонд", value: "8", note: "2 единицы убыточны по затратам" }
];

const dashboardStreams = [
  {
    title: "Сегодня в работе",
    items: [
      "Платежи аренды, которые должны поступить до конца дня",
      "Выкупы с риском просрочки на ближайшие 48 часов",
      "Возвраты залога, ожидающие подтверждения менеджера"
    ]
  },
  {
    title: "Что должно быть на backend",
    items: [
      "Долг, штрафы, график и частичные оплаты считаются только на сервере",
      "RBAC и ограничения по точкам проверяются на backend",
      "Финансовые операции и возврат залога идут транзакционно"
    ]
  },
  {
    title: "Референсы из текущего проекта",
    items: [
      "Telegram-сценарии и queue-подход для уведомлений",
      "Mobile-first паттерны карточек и быстрых действий",
      "Логика partial payment как отдельный критичный контур"
    ]
  }
];

export default function DashboardPage() {
  return (
    <div className="section-stack">
      <section className="hero-panel hero-panel-dashboard">
        <div className="hero-copy">
          <div className="hero-eyebrow">Dashboard</div>
          <h2 className="hero-title">Операционный штаб отдельной CRM</h2>
          <p className="hero-summary">
            Новый продукт строится вокруг сделок аренды и выкупа, а не вокруг заказов МойСклад.
            Это mobile-first SaaS, где критичные расчеты, права и финансы живут на backend.
          </p>
        </div>

        <div className="hero-side-panel">
          <div className="hero-side-label">Core promise</div>
          <div className="hero-side-title">Deal-centric platform</div>
          <p>
            Клиенты, техника, графики, залоги, штрафы, ремонты, документы, уведомления и SaaS-изоляция
            проектируются как единая доменная модель.
          </p>
        </div>
      </section>

      <section className="metrics-grid">
        {heroMetrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <div className="metric-label">{metric.label}</div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-note">{metric.note}</div>
          </article>
        ))}
      </section>

      <section className="content-grid">
        {dashboardStreams.map((stream) => (
          <article className="surface-card" key={stream.title}>
            <div className="surface-kicker">Overview</div>
            <h3>{stream.title}</h3>
            <ul className="surface-list">
              {stream.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section className="surface-card">
        <div className="surface-kicker">Route map</div>
        <h3>Разделы продукта</h3>
        <div className="route-grid">
          {NAV_ITEMS.map((item) => (
            <article className="route-card" key={item.href}>
              <div className="route-card-title">{item.label}</div>
              <div className="route-card-note">{item.description}</div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
