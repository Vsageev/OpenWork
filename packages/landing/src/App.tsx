import { type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  Clock,
  FileText,
  FolderOpen,
  Inbox,
  Kanban,
  KanbanSquare,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Terminal,
  User,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

const APP_URL = (import.meta.env.VITE_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');

export function App() {
  return (
    <div className="shell">
      <Header />
      <main>
        <Hero />
        <ProofStrip />
        <InterfaceShowcase />
        <CapabilityGrid />
        <OperatingLoop />
        <SplitNarrative />
        <Connectors />
        <Assurance />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

function BrandLogo() {
  return (
    <a className="logo" href="/" aria-label="OpenWork home">
      <span className="logo__mark" aria-hidden="true">
        <span className="logo__square" />
        <span className="logo__square" />
        <span className="logo__square" />
        <span className="logo__square" />
      </span>
      <span className="logo__word">OpenWork</span>
    </a>
  );
}

function Header() {
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <BrandLogo />
        <nav className="topbar__nav" aria-label="Primary">
          <a href="#capabilities">Capabilities</a>
          <a href="#loop">How it runs</a>
          <a href="#connectors">Connectors</a>
        </nav>
        <div className="topbar__cta">
          <a className="link-quiet" href={`${APP_URL}/login`}>
            Sign in
          </a>
          <a className="btn btn--primary" href={`${APP_URL}/register`}>
            Open workspace
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="hero__inner">
        <div className="hero__copy">
          <p className="kicker">Workspace platform</p>
          <h1 id="hero-heading" className="hero__title">
            Keep work, conversation, and agents on one surface.
          </h1>
          <p className="hero__lede">
            Boards, inboxes, automations, and AI agents share the same records — so context stays
            attached from first message to shipped outcome.
          </p>
          <div className="hero__actions">
            <a className="btn btn--primary btn--lg" href={`${APP_URL}/register`}>
              Start free
              <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
            </a>
            <a className="btn btn--secondary btn--lg" href="#capabilities">
              Explore capabilities
            </a>
          </div>
          <dl className="hero__facts">
            <div>
              <dt>Model</dt>
              <dd>API-first collections you can back up and inspect</dd>
            </div>
            <div>
              <dt>Agents</dt>
              <dd>Runs, logs, and outputs land on the originating card</dd>
            </div>
          </dl>
        </div>

        <div className="hero__panel" aria-hidden="true">
          <div className="app-chrome">
            <div className="app-chrome__titlebar">
              <span className="app-chrome__dots" aria-hidden="true" />
              <span className="app-chrome__title">OpenWork</span>
              <span className="app-chrome__ws">Acme · Production</span>
            </div>
            <div className="app-chrome__body">
              <div className="app-chrome__rail">
                <span className="app-chrome__rail-item is-active">
                  <LayoutGrid size={16} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="app-chrome__rail-item">
                  <Kanban size={16} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="app-chrome__rail-item">
                  <Inbox size={16} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="app-chrome__rail-item">
                  <Bot size={16} strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="app-chrome__rail-spacer" />
                <span className="app-chrome__rail-item">
                  <Settings size={16} strokeWidth={2} aria-hidden="true" />
                </span>
              </div>
              <div className="app-chrome__stage">
                <div className="app-chrome__toolbar">
                  <span className="app-chrome__tab is-active">Boards</span>
                  <span className="app-chrome__tab">Inbox</span>
                  <span className="app-chrome__tab">Agents</span>
                  <span className="app-chrome__toolbar-filler" />
                  <span className="app-chrome__search">
                    <Search size={13} strokeWidth={2} aria-hidden="true" />
                    Find cards…
                  </span>
                </div>
                <div className="app-chrome__content">
                  <div className="surface-card surface-card--hero">
                    <header className="mini-head">
                      <span className="mini-head__label">Live board</span>
                      <span className="mini-head__pill">4 owners · 2 agents</span>
                    </header>
                    <p className="mini-title">Customer launch — April window</p>
                    <ul className="mini-columns">
                      <li>
                        <span className="mini-columns__name">Intake</span>
                        <span className="mini-columns__n">5</span>
                      </li>
                      <li className="is-active">
                        <span className="mini-columns__name">Build</span>
                        <span className="mini-columns__n">3</span>
                      </li>
                      <li>
                        <span className="mini-columns__name">Verify</span>
                        <span className="mini-columns__n">2</span>
                      </li>
                    </ul>
                    <div className="mini-stack">
                      <div className="mini-card">
                        <span className="mini-tag mini-tag--blue">Inbox</span>
                        <p>Widget feedback — checkout step</p>
                        <span className="mini-meta">
                          <MessageSquare size={12} aria-hidden="true" />6
                        </span>
                      </div>
                      <div className="mini-card mini-card--accent">
                        <span className="mini-tag mini-tag--green">Agent</span>
                        <p>Draft incident summary from thread</p>
                        <span className="mini-meta mini-meta--live">
                          <Bot size={12} aria-hidden="true" />
                          Running
                        </span>
                      </div>
                    </div>
                  </div>
                  <aside className="surface-card surface-card--note">
                    <p className="note__label">Run log</p>
                    <p className="note__title">Writer · card #214</p>
                    <ul className="note__list">
                      <li>
                        <Check size={12} aria-hidden="true" />
                        Parsed 14 messages
                      </li>
                      <li>
                        <Check size={12} aria-hidden="true" />
                        Linked collection · Support
                      </li>
                      <li className="is-pending">Posting summary to card…</li>
                    </ul>
                  </aside>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProofStrip() {
  const items: [LucideIcon, string][] = [
    [KanbanSquare, 'Boards'],
    [Inbox, 'Inbox'],
    [Bot, 'Agents'],
    [Webhook, 'Webhooks'],
    [Layers, 'Collections'],
    [LayoutGrid, 'Widgets'],
  ];
  return (
    <section className="strip" aria-label="Product surfaces">
      <div className="strip__inner">
        <span className="strip__eyebrow">In one workspace</span>
        <ul className="strip__list">
          {items.map(([Icon, label]) => (
            <li key={label}>
              <Icon size={15} strokeWidth={2} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function InterfaceShowcase() {
  return (
    <section className="section section--showcase" aria-labelledby="showcase-heading">
      <div className="section__intro">
        <p className="kicker">Inside the app</p>
        <h2 id="showcase-heading" className="section__title">
          Dashboard, inbox, and agent runs in one place.
        </h2>
        <p className="section__lede">
          Static representations of the same panels you get after sign-in — no stock photography,
          just the interface patterns teams actually use.
        </p>
      </div>
      <div className="showcase">
        <article className="showcase__card">
          <header className="showcase__head">
            <span className="showcase__label">Workspace overview</span>
            <span className="showcase__pill">Live</span>
          </header>
          <p className="showcase__title">Dashboard</p>
          <div className="showcase__stats">
            {[
              { icon: FolderOpen, label: 'Collections', n: '12', tint: 'rgba(59,130,246,0.12)' },
              { icon: Kanban, label: 'Boards', n: '5', tint: 'rgba(139,92,246,0.12)' },
              { icon: FileText, label: 'Cards', n: '248', tint: 'rgba(245,158,11,0.12)' },
              { icon: Bot, label: 'Agents', n: '3', tint: 'rgba(16,185,129,0.12)' },
            ].map(({ icon: Icon, label, n, tint }) => (
              <div className="showcase__stat" key={label} style={{ background: tint }}>
                <Icon size={15} strokeWidth={2} aria-hidden="true" />
                <div>
                  <span className="showcase__stat-n">{n}</span>
                  <span className="showcase__stat-l">{label}</span>
                </div>
                <ChevronDown size={14} className="showcase__stat-chev" strokeWidth={2} aria-hidden="true" />
              </div>
            ))}
          </div>
        </article>

        <article className="showcase__card">
          <header className="showcase__head">
            <span className="showcase__label">Conversations</span>
            <span className="showcase__pill showcase__pill--soft">2 unread</span>
          </header>
          <p className="showcase__title">Inbox</p>
          <div className="inbox-mock" role="presentation">
            <div className="inbox-mock__row is-unread">
              <span className="inbox-mock__avatar" aria-hidden="true">
                SK
              </span>
              <div className="inbox-mock__main">
                <div className="inbox-mock__top">
                  <span className="inbox-mock__name">Sasha K.</span>
                  <span className="inbox-mock__time">2m</span>
                </div>
                <p className="inbox-mock__preview">Checkout fails on mobile Safari…</p>
                <span className="inbox-mock__ch">Telegram</span>
              </div>
            </div>
            <div className="inbox-mock__row">
              <span className="inbox-mock__avatar inbox-mock__avatar--neutral" aria-hidden="true">
                PT
              </span>
              <div className="inbox-mock__main">
                <div className="inbox-mock__top">
                  <span className="inbox-mock__name">Priority queue</span>
                  <span className="inbox-mock__time">1h</span>
                </div>
                <p className="inbox-mock__preview">Re: contract draft — need legal sign-off</p>
                <span className="inbox-mock__ch">Email</span>
              </div>
            </div>
            <div className="inbox-mock__row">
              <span className="inbox-mock__avatar" aria-hidden="true">
                IV
              </span>
              <div className="inbox-mock__main">
                <div className="inbox-mock__top">
                  <span className="inbox-mock__name">Internal</span>
                  <span className="inbox-mock__time">Yesterday</span>
                </div>
                <p className="inbox-mock__preview">Move card 214 to Verify when build lands</p>
                <span className="inbox-mock__ch">Internal</span>
              </div>
            </div>
          </div>
        </article>

        <article className="showcase__card">
          <header className="showcase__head">
            <span className="showcase__label">Activity</span>
            <span className="showcase__pill">Runs</span>
          </header>
          <p className="showcase__title">Agents &amp; webhooks</p>
          <ul className="run-mock" role="presentation">
            <li>
              <span className="run-mock__icon run-mock__icon--ok">
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
              </span>
              <div>
                <p className="run-mock__t">Writer · card #214</p>
                <p className="run-mock__m">Card assignment · 4.2s</p>
              </div>
              <Zap size={13} className="run-mock__trig" strokeWidth={2} aria-hidden="true" />
            </li>
            <li>
              <span className="run-mock__icon run-mock__icon--run">
                <Clock size={12} strokeWidth={2} aria-hidden="true" />
              </span>
              <div>
                <p className="run-mock__t">Nightly digest</p>
                <p className="run-mock__m">Cron · running…</p>
              </div>
              <Clock size={13} className="run-mock__trig" strokeWidth={2} aria-hidden="true" />
            </li>
            <li>
              <span className="run-mock__icon run-mock__icon--ok">
                <Check size={12} strokeWidth={2.5} aria-hidden="true" />
              </span>
              <div>
                <p className="run-mock__t">ingest/telegram</p>
                <p className="run-mock__m">Webhook · 201 · 32ms</p>
              </div>
              <Webhook size={13} className="run-mock__trig" strokeWidth={2} aria-hidden="true" />
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function CapPreviewBoards() {
  return (
    <div className="cap-preview" aria-hidden="true">
      <div className="cap-preview__board">
        <div className="cap-preview__col">
          <span className="cap-preview__h">Backlog</span>
          <div className="cap-preview__card" />
          <div className="cap-preview__card" />
        </div>
        <div className="cap-preview__col cap-preview__col--active">
          <span className="cap-preview__h">In progress</span>
          <div className="cap-preview__card cap-preview__card--tall" />
        </div>
        <div className="cap-preview__col">
          <span className="cap-preview__h">Done</span>
          <div className="cap-preview__card" />
        </div>
      </div>
    </div>
  );
}

function CapPreviewInbox() {
  return (
    <div className="cap-preview cap-preview--inbox" aria-hidden="true">
      <div className="cap-inbox__toolbar">
        <span className="cap-inbox__fake">
          <Search size={12} strokeWidth={2} aria-hidden="true" />
        </span>
        <span className="cap-inbox__filter">All channels</span>
        <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
      </div>
      <ul className="cap-inbox__list">
        <li>
          <span className="cap-inbox__dot" />
          <span className="cap-inbox__line cap-inbox__line--long" />
        </li>
        <li>
          <span className="cap-inbox__dot" />
          <span className="cap-inbox__line" />
        </li>
        <li>
          <span className="cap-inbox__dot cap-inbox__dot--soft" />
          <span className="cap-inbox__line cap-inbox__line--med" />
        </li>
      </ul>
    </div>
  );
}

function CapPreviewAgents() {
  return (
    <div className="cap-preview cap-preview--chat" aria-hidden="true">
      <div className="cap-chat__header">
        <span className="cap-chat__avatar" aria-hidden="true" />
        <div>
          <p className="cap-chat__name">Writer</p>
          <p className="cap-chat__sub">Card #214 · 2 files</p>
        </div>
        <MoreHorizontal size={14} strokeWidth={2} className="cap-chat__more" aria-hidden="true" />
      </div>
      <div className="cap-chat__bubbles">
        <div className="cap-chat__bubble cap-chat__bubble--user">
          Summarize the last 14 customer messages and propose next steps.
        </div>
        <div className="cap-chat__bubble cap-chat__bubble--agent">
          I pulled quotes from 3 messages and drafted a 4-bullet summary. Ready to post to the
          card.
        </div>
      </div>
      <div className="cap-chat__input">
        <span className="cap-chat__placeholder">Message Writer…</span>
        <Send size={14} strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  );
}

function CapPreviewWebhooks() {
  return (
    <div className="cap-preview cap-preview--code" aria-hidden="true">
      <div className="cap-code__bar">
        <span className="cap-code__method">POST</span>
        <span className="cap-code__path">/v1/hooks/ingest/telegram</span>
      </div>
      <pre className="cap-code__block">
{`{
  "event": "message.received",
  "cardId": "c-214",
  "deliveryId": "d-9f2a",
  "signed": true
}`}
      </pre>
    </div>
  );
}

const CAPABILITIES: {
  icon: LucideIcon;
  title: string;
  body: string;
  points: string[];
  preview: () => ReactNode;
}[] = [
  {
    icon: KanbanSquare,
    title: 'Boards that hold real context',
    body: 'Cards carry owners, tags, files, linked collections, and the conversation that created them.',
    points: ['Presets for repeat work', 'Column rules without ceremony', 'History stays on the card'],
    preview: CapPreviewBoards,
  },
  {
    icon: Inbox,
    title: 'Inbox without tool hopping',
    body: 'Bring channels next to the board so triage happens where execution already lives.',
    points: ['Thread to card in one step', 'Internal notes beside external mail', 'SLA-friendly queues'],
    preview: CapPreviewInbox,
  },
  {
    icon: Bot,
    title: 'Agents with receipts',
    body: 'Dispatch focused work to an agent and review outputs on the same surface as your team.',
    points: ['Per-card runs', 'Logs you can search', 'Approvals before publish'],
    preview: CapPreviewAgents,
  },
  {
    icon: Webhook,
    title: 'Automation you can audit',
    body: 'Scheduled jobs and integrations write back to the records that triggered them.',
    points: ['Signed deliveries', 'Cron templates', 'Embeds for customer-facing intake'],
    preview: CapPreviewWebhooks,
  },
];

function CapabilityGrid() {
  return (
    <section className="section" id="capabilities" aria-labelledby="cap-heading">
      <div className="section__intro">
        <p className="kicker">Capabilities</p>
        <h2 id="cap-heading" className="section__title">
          Primitives that snap together.
        </h2>
        <p className="section__lede">
          OpenWork is built for teams that need accountable handoffs — not another chat window without
          a source of truth.
        </p>
      </div>
      <div className="cap-grid">
        {CAPABILITIES.map(({ icon: Icon, title, body, points, preview: Preview }) => (
          <article className="cap-card" key={title}>
            <span className="cap-card__icon">
              <Icon size={20} strokeWidth={2} aria-hidden="true" />
            </span>
            <h3 className="cap-card__title">{title}</h3>
            <p className="cap-card__body">{body}</p>
            <div className="cap-card__preview">
              <Preview />
            </div>
            <ul className="cap-card__list">
              {points.map((p) => (
                <li key={p}>
                  <Check size={14} strokeWidth={2} aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

const LOOP: { title: string; detail: string }[] = [
  {
    title: 'Capture',
    detail: 'Messages, widgets, and webhooks become cards with originating context attached.',
  },
  {
    title: 'Coordinate',
    detail: 'Assign owners, route across boards, and link collections without retyping the story.',
  },
  {
    title: 'Automate',
    detail: 'Agents and jobs pick up scoped tasks; every run references the card that started it.',
  },
  {
    title: 'Close',
    detail: 'Files, diffs, and decisions attach back to the same record for a clean audit trail.',
  },
];

function OperatingLoop() {
  return (
    <section className="section section--band" id="loop" aria-labelledby="loop-heading">
      <div className="section__intro">
        <p className="kicker">Operating loop</p>
        <h2 id="loop-heading" className="section__title">
          A straight line from request to receipt.
        </h2>
      </div>
      <ol className="loop">
        {LOOP.map((step, i) => (
          <li className="loop__step" key={step.title}>
            <span className="loop__index">{String(i + 1).padStart(2, '0')}</span>
            <div className="loop__body">
              <h3>{step.title}</h3>
              <p>{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SplitNarrative() {
  return (
    <section className="section" aria-labelledby="split-a-heading">
      <div className="split">
        <div className="split__block">
          <p className="kicker">For operators</p>
          <h2 id="split-a-heading" className="section__title">
            One queue for everything that needs a decision.
          </h2>
          <p className="section__lede section__lede--tight">
            Route intake to the right board, keep customer context beside internal notes, and see
            status without opening five tabs.
          </p>
          <ul className="checklist">
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Channel-aware triage
            </li>
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Presets for repeat requests
            </li>
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Owners and reviewers on every card
            </li>
          </ul>
        </div>
        <div className="split__visual" aria-hidden="true">
          <div className="split-mock split-mock--ops">
            <div className="split-mock__row">
              <span className="split-mock__label">Triage</span>
              <span className="split-mock__chips">
                <span>Telegram</span>
                <span>Slack</span>
                <span>Email</span>
              </span>
            </div>
            <ul className="split-mock__tickets">
              <li>
                <Inbox size={14} strokeWidth={2} aria-hidden="true" />
                <div>
                  <p>Widget checkout — new thread</p>
                  <span>→ Customer launch board · Build</span>
                </div>
                <span className="split-mock__assign">
                  <User size={12} strokeWidth={2} aria-hidden="true" />
                </span>
              </li>
              <li>
                <MessageSquare size={14} strokeWidth={2} aria-hidden="true" />
                <div>
                  <p>Internal: unblock legal review</p>
                  <span>· Card #198</span>
                </div>
                <span className="split-mock__badge">Note</span>
              </li>
            </ul>
            <div className="split-mock__footer">
              <span>Create card from thread</span>
              <span className="split-mock__kbd">↵</span>
            </div>
          </div>
        </div>
        <div className="split__block">
          <p className="kicker">For builders</p>
          <h2 className="section__title">APIs and agents beside the same schema.</h2>
          <p className="section__lede section__lede--tight">
            Script against workspace collections, wire webhooks, and let agents operate with the same
            identifiers your integrations use.
          </p>
          <ul className="checklist">
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Typed collections and backups
            </li>
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Scoped keys and 2FA-ready auth
            </li>
            <li>
              <Check size={14} strokeWidth={2} aria-hidden="true" />
              Run logs tied to source cards
            </li>
          </ul>
        </div>
        <div className="split__visual" aria-hidden="true">
          <div className="split-mock split-mock--dev">
            <div className="split-mock__api">
              <code>GET /v1/workspaces/ws_01/collections</code>
              <span className="split-mock__code-badge">200</span>
            </div>
            <ul className="split-mock__meta">
              <li>
                <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
                <span>sk_live · cards:rw</span>
              </li>
              <li>
                <Link2 size={13} strokeWidth={2} aria-hidden="true" />
                <span>card_214 → agent run ar_8c4</span>
              </li>
            </ul>
            <div className="split-mock__webhook">
              <p>
                <Webhook size={12} strokeWidth={2} aria-hidden="true" />
                Inbound delivery verified
              </p>
              <span>signature: ed25519 · id: d-9f2a</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const CONNECTOR_ITEMS: { icon: LucideIcon; name: string; blurb: string }[] = [
  { icon: MessageSquare, name: 'Telegram', blurb: 'Threads that open cards with transcripts.' },
  { icon: Webhook, name: 'Webhooks', blurb: 'Inbound and outbound with delivery records.' },
  { icon: Terminal, name: 'CLI & HTTP API', blurb: 'Scriptable routes for workspace data.' },
  { icon: KeyRound, name: 'Access control', blurb: 'Scoped keys, roles, and audit-friendly auth.' },
  { icon: Link2, name: 'Embeds', blurb: 'Customer-facing surfaces that feed the same inbox.' },
  { icon: Layers, name: 'Collections', blurb: 'Shared shapes for files, tags, and links.' },
];

function Connectors() {
  return (
    <section className="section" id="connectors" aria-labelledby="conn-heading">
      <div className="conn-head">
        <div>
          <p className="kicker">Connectors</p>
          <h2 id="conn-heading" className="section__title">
            Meet the systems you already run.
          </h2>
          <p className="section__lede section__lede--tight">
            Everything is observable: deliveries, agent runs, and scheduled jobs leave a trail on the
            records they touch.
          </p>
          <a className="link-arrow" href={`${APP_URL}/register`}>
            Open a workspace
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </a>
        </div>
      </div>
      <ul className="conn-grid">
        {CONNECTOR_ITEMS.map(({ icon: Icon, name, blurb }) => (
          <li className="conn-tile" key={name}>
            <span className="conn-tile__icon">
              <Icon size={18} strokeWidth={2} aria-hidden="true" />
            </span>
            <div>
              <strong>{name}</strong>
              <p>{blurb}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Assurance() {
  return (
    <section className="section section--tight" aria-labelledby="trust-heading">
      <div className="section__intro">
        <p className="kicker">Trust</p>
        <h2 id="trust-heading" className="section__title">
          Built for teams that answer to someone.
        </h2>
      </div>
      <div className="trust-row">
        <article className="trust-item">
          <span className="trust-item__icon">
            <ShieldCheck size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>Permissions first</h3>
          <p>JWT sessions, scoped API keys, optional 2FA, and backups as part of the platform shape.</p>
        </article>
        <article className="trust-item">
          <span className="trust-item__icon">
            <Layers size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>Open records</h3>
          <p>Workspace data stays structured and exportable — not trapped in an opaque transcript.</p>
        </article>
        <article className="trust-item">
          <span className="trust-item__icon">
            <Terminal size={20} strokeWidth={2} aria-hidden="true" />
          </span>
          <h3>Inspectable runs</h3>
          <p>Agents and jobs return outputs where the work started, with logs you can search later.</p>
        </article>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="section section--cta" aria-labelledby="cta-heading">
      <div className="cta">
        <div className="cta__copy">
          <p className="kicker">Get started</p>
          <h2 id="cta-heading" className="cta__title">
            Move your next launch onto a single surface.
          </h2>
          <p className="cta__lede">
            Create a workspace, connect an inbox, and invite the people who actually ship — agents
            included.
          </p>
        </div>
        <div className="cta__actions">
          <a className="btn btn--primary btn--lg" href={`${APP_URL}/register`}>
            Create workspace
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
          </a>
          <a className="btn btn--ghost btn--lg" href={`${APP_URL}/login`}>
            I already have access
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot__inner">
        <div className="foot__brand">
          <BrandLogo />
          <p>Boards, inboxes, automations, and agents — one accountable workspace.</p>
        </div>
        <div className="foot__cols">
          <FooterColumn
            title="Product"
            links={[
              ['Capabilities', '#capabilities'],
              ['Operating loop', '#loop'],
              ['Connectors', '#connectors'],
            ]}
          />
          <FooterColumn
            title="Account"
            links={[
              ['Sign in', `${APP_URL}/login`],
              ['Register', `${APP_URL}/register`],
            ]}
          />
        </div>
      </div>
      <div className="foot__meta">
        <span>© {new Date().getFullYear()} OpenWork</span>
        <span>Clarity over noise · receipts over vibes</span>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div className="foot__col">
      <span className="foot__col-title">{title}</span>
      <ul>
        {links.map(([label, href]) => (
          <li key={label}>
            <a href={href}>{label}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
