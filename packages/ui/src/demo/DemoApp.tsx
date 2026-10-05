import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Bell,
  BookOpen,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Command,
  Database,
  FileCode2,
  FileText,
  FolderGit2,
  Gauge,
  GitBranch,
  GitCommit,
  GitMerge,
  Github,
  Layers3,
  LayoutDashboard,
  LifeBuoy,
  Link as LinkIcon,
  ListChecks,
  LockKeyhole,
  MessageCircleQuestion,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  TestTube2,
  Ticket,
  TimerReset,
  TriangleAlert,
  UserRound,
  Users,
  WandSparkles,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  NavLink,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router-dom';

type Tone =
  | 'neutral'
  | 'mint'
  | 'blue'
  | 'warning'
  | 'danger'
  | 'orange'
  | 'purple';

const q = '?demo=1';
const demoPath = (path: string) => `${path}${q}`;

export function isDemoMode() {
  return (
    new URLSearchParams(window.location.search).get('demo') === '1' ||
    import.meta.env.VITE_DEMO_MODE === '1'
  );
}

function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`d-badge d-${tone}`}>
      {dot && <span className="d-badge-dot" />}
      {children}
    </span>
  );
}

function Button({
  children,
  variant = 'secondary',
  icon,
  disabled = false,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`d-button d-button-${variant}`}
      disabled={disabled}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  label,
  children,
}: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="d-icon-button"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`d-panel ${className}`}>{children}</section>;
}

function SectionHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="d-section-head">
      <div className="d-section-title">{title}</div>
      {meta && <span className="d-section-meta">{meta}</span>}
      <span className="d-flex-spacer" />
      {action}
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
}: {
  eyebrow?: ReactNode;
  title: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="d-page-header">
      <div className="d-page-heading">
        {eyebrow && <div className="d-eyebrow">{eyebrow}</div>}
        <div className="d-title-row">
          <h1>{title}</h1>
          {meta}
        </div>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="d-header-actions">{actions}</div>}
    </header>
  );
}

function Tabs({
  items,
  active,
  onChange,
}: {
  items: Array<{ label: string; count?: number }>;
  active: string;
  onChange?: (label: string) => void;
}) {
  return (
    <div className="d-tabs" role="tablist">
      {items.map((item) => (
        <button
          type="button"
          className={active === item.label ? 'active' : ''}
          key={item.label}
          onClick={() => onChange?.(item.label)}
          role="tab"
          aria-selected={active === item.label}
        >
          {item.label}
          {item.count !== undefined && <span>{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
}) {
  return (
    <div className={`d-metric d-metric-${tone}`}>
      <div className="d-metric-label">{label}</div>
      <div className="d-metric-value">{value}</div>
      {detail && <div className="d-metric-detail">{detail}</div>}
    </div>
  );
}

function ProgressRing({
  value,
  tone = 'mint',
}: { value: number; tone?: Tone }) {
  const circumference = 2 * Math.PI * 15;
  const offset = circumference - (circumference * value) / 100;
  return (
    <span className={`d-ring d-ring-${tone}`} aria-label={`${value} percent`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="d-ring-track" cx="18" cy="18" r="15" />
        <circle
          className="d-ring-value"
          cx="18"
          cy="18"
          r="15"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <b>{value}</b>
    </span>
  );
}

const navGroups = [
  {
    label: 'Work',
    items: [
      { to: '/', label: 'Home', icon: LayoutDashboard, count: 9 },
      { to: '/tickets/team-a/SR-0142', label: 'Tickets', icon: Ticket },
      {
        to: '/tickets/team-a/SR-0142/review',
        label: 'Review',
        icon: Code2,
        count: 2,
      },
      { to: '/runs', label: 'Runs', icon: SquareTerminal, count: 3 },
      { to: '/queue', label: 'Failures', icon: LifeBuoy, count: 1 },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/kb', label: 'Knowledge base', icon: BookOpen },
      { to: '/metrics', label: 'Metrics', icon: Gauge },
      { to: '/ledger', label: 'Ledger', icon: ListChecks },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/workspaces', label: 'Workspaces', icon: Layers3 },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="d-app">
      <aside className="d-sidebar">
        <div className="d-brand-row">
          <div className="d-logo" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <div className="d-brand">Veto</div>
            <div className="d-tagline">Agents propose. Humans veto.</div>
          </div>
        </div>
        <nav className="d-nav" aria-label="Primary navigation">
          {navGroups.map((group) => (
            <div className="d-nav-group" key={group.label}>
              <div className="d-nav-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={demoPath(item.to)}
                    end={item.to === '/'}
                  >
                    <Icon size={15} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.count && <em>{item.count}</em>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="d-workspace-list">
          <div className="d-nav-label">Workspaces</div>
          <div className="d-workspace-active">
            <FolderGit2 size={14} />
            <span>team-a</span>
            <Badge tone="mint">healthy</Badge>
          </div>
          <div className="d-workspace-row">
            <FolderGit2 size={14} />
            <span>eng-portal</span>
            <em>3</em>
          </div>
        </div>
        <div className="d-sidebar-footer">
          <div className="d-avatar">KG</div>
          <div>
            <strong>Keith Goff</strong>
            <span>operator</span>
          </div>
          <MoreHorizontal size={16} />
        </div>
      </aside>
      <div className="d-stage">
        <div className="d-topbar">
          <button type="button" className="d-command">
            <Search size={14} />
            <span>Search or run a command…</span>
            <kbd>⌘ K</kbd>
          </button>
          <span className="d-top-spacer" />
          <button type="button" className="d-scope">
            <Layers3 size={14} />
            All workspaces
            <ChevronDown size={13} />
          </button>
          <span className="d-demo-flag">
            <Sparkles size={13} /> Demo data
          </span>
          <IconButton label="Notifications">
            <Bell size={16} />
            <span className="d-unread" />
          </IconButton>
        </div>
        <main className="d-main" key={location.pathname}>
          {children}
        </main>
      </div>
    </div>
  );
}

const gateGroups = [
  {
    label: 'Questions',
    count: 3,
    tone: 'purple' as Tone,
    items: [
      [
        'SR-0142',
        'Which cache backend should sessions use?',
        'team-a',
        'P1',
        'needs-info',
        '2h',
        '62',
        'KG',
      ],
      [
        'SR-0138',
        'Confirm the customer-facing persona name',
        'team-a',
        'P2',
        'needs-info',
        '5h',
        '78',
        '',
      ],
      [
        'WEB-77',
        'SSO provider — Okta or Entra?',
        'eng-portal',
        'P0',
        'needs-info',
        '1d',
        '41',
        '',
      ],
    ],
  },
  {
    label: 'Approvals',
    count: 2,
    tone: 'blue' as Tone,
    items: [
      [
        'SR-0140',
        'PRD v3 ready — Notification fan-out',
        'team-a',
        'P1',
        'prd-review',
        '3h',
        '84',
        '',
      ],
      [
        'WEB-81',
        'Split plan — 4 children proposed',
        'eng-portal',
        'P2',
        'split-plan',
        '2d',
        '71',
        '',
      ],
    ],
  },
];

function GateRow({ item, tone }: { item: string[]; tone: Tone }) {
  const [id, title, workspace, priority, status, age, score, claimed] = item;
  const href = `/tickets/${workspace}/${id}`;
  return (
    <NavLink className="d-gate-row" to={demoPath(href)}>
      <span className="d-blocked-dot" aria-label="agent blocked" />
      <span className="d-rank mono">
        {id === 'SR-0142' ? '01' : id === 'WEB-77' ? '03' : '02'}
      </span>
      <div className="d-gate-copy">
        <div className="d-gate-title">
          <strong className="mono">{id}</strong>
          <span>{title}</span>
          <Badge tone={tone}>{status}</Badge>
        </div>
        <div className="d-gate-meta">
          <span>{workspace}</span>
          <span className={priority === 'P0' ? 'd-red' : ''}>{priority}</span>
          <span>{age} ago</span>
          <span
            className={`d-score ${Number(score) < 50 ? 'low' : Number(score) < 75 ? 'mid' : 'good'}`}
          >
            ◐ {score}
          </span>
          {claimed && <span>claimed · {claimed}</span>}
        </div>
      </div>
      <div className="d-row-actions">
        <button type="button" title="Snooze">
          z
        </button>
        <button type="button" title="Claim">
          c
        </button>
        <ArrowRight size={15} />
      </div>
    </NavLink>
  );
}

function InboxScreen() {
  return (
    <div className="d-page d-inbox-page">
      <PageHeader
        title="Inbox"
        description="Human decisions, ranked by what is blocking the system."
        meta={
          <Badge tone="warning" dot>
            9 open
          </Badge>
        }
        actions={
          <Button variant="quiet" icon={<RefreshCw size={14} />}>
            Refresh
          </Button>
        }
      />
      <InboxContent />
    </div>
  );
}

function InboxContent() {
  return (
    <>
      <div className="d-toolbar">
        <button type="button">
          <PanelLeft size={14} /> All workspaces <ChevronDown size={13} />
        </button>
        <button type="button">
          All kinds <ChevronDown size={13} />
        </button>
        <span className="d-check">
          <span className="d-checkbox">
            <Check size={11} />
          </span>{' '}
          Worst specs first
        </span>
        <span className="d-flex-spacer" />
        <span className="d-live">
          <i /> Live
        </span>
        <span className="d-updated">Updated 14s ago</span>
      </div>
      <Panel className="d-list-panel">
        {gateGroups.map((group) => (
          <div className="d-gate-group" key={group.label}>
            <SectionHeader
              title={group.label}
              meta={`${group.count} · agents blocked`}
              action={<ChevronDown size={15} />}
            />
            {group.items.map((item) => (
              <GateRow key={item[0]} item={item} tone={group.tone} />
            ))}
          </div>
        ))}
        <div className="d-collapsed-groups">
          {[
            ['Reviews', '1', 'mint'],
            ['Failures', '1', 'danger'],
            ['Escalations', '1', 'orange'],
            ['Repair', '1', 'warning'],
          ].map(([label, count, tone]) => (
            <button type="button" key={label}>
              <ChevronRight size={14} />
              <Badge tone={tone as Tone}>{label}</Badge>
              <span>{count} item</span>
              <span className="d-flex-spacer" />
              <span>
                {label === 'Failures'
                  ? 'implement · timeout'
                  : label === 'Repair'
                    ? 'PRD parse failed'
                    : 'Open group'}
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <div className="d-key-rail">
        <span>
          <kbd>j</kbd>
          <kbd>k</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> open
        </span>
        <span>
          <kbd>x</kbd> snooze
        </span>
        <span>
          <kbd>c</kbd> claim
        </span>
        <span>
          <kbd>?</kbd> shortcuts
        </span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Board home — D21/s-01-board.md: Kanban default tab, inbox tab 2.    */
/* ------------------------------------------------------------------ */

type CardBadge = { label: string; tone: Tone | 'cyan'; loud?: boolean };
type BoardCard = {
  id: string;
  title: string;
  ws: string;
  pri: string;
  sub: string;
  age: string;
  badges: CardBadge[];
  claim?: string;
  failed?: boolean;
  run?: string;
};

const boardColumns: Array<{
  name: string;
  wip?: number;
  cards: BoardCard[];
  more?: number;
}> = [
  {
    name: 'Backlog',
    wip: 8,
    cards: [
      {
        id: 'WEB-77',
        title: 'SSO provider — Okta or Entra?',
        ws: 'eng-portal',
        pri: 'P0',
        sub: 'escalated',
        age: '1d',
        badges: [
          { label: 'escalated', tone: 'orange', loud: true },
          { label: 'Q&A · 2 open', tone: 'purple' },
        ],
      },
      {
        id: 'SR-0142',
        title: 'Session cache backend',
        ws: 'team-a',
        pri: 'P1',
        sub: 'needs-info',
        age: '2h',
        badges: [{ label: 'Q&A', tone: 'purple' }],
        claim: 'KG',
      },
      {
        id: 'SR-0138',
        title: 'Confirm persona name in copy',
        ws: 'team-a',
        pri: 'P2',
        sub: 'needs-info',
        age: '5h',
        badges: [{ label: 'Q&A', tone: 'purple' }],
      },
      {
        id: 'SR-0151',
        title: 'Rate limiting for public API',
        ws: 'team-a',
        pri: 'P2',
        sub: 'imported',
        age: '20m',
        badges: [],
      },
    ],
  },
  {
    name: 'Spec',
    wip: 6,
    cards: [
      {
        id: 'SR-0140',
        title: 'Notification fan-out',
        ws: 'team-a',
        pri: 'P1',
        sub: 'prd-review',
        age: '3h',
        badges: [{ label: 'approve PRD v3', tone: 'blue' }],
      },
      {
        id: 'WEB-81',
        title: 'Checkout split into 4 tickets',
        ws: 'eng-portal',
        pri: 'P2',
        sub: 'split-plan',
        age: '2d',
        badges: [{ label: '4 children', tone: 'cyan' }],
      },
      {
        id: 'SR-0146',
        title: 'Webhook retry policy',
        ws: 'team-a',
        pri: 'P2',
        sub: 'test-review',
        age: '6h',
        badges: [{ label: 'approve tests', tone: 'blue' }],
      },
      {
        id: 'SR-0144',
        title: 'Session cache layer',
        ws: 'team-a',
        pri: 'P1',
        sub: 'tdd-draft',
        age: '40m',
        badges: [],
        run: 'tdd · running 12m',
      },
    ],
  },
  {
    name: 'Build',
    wip: 2,
    cards: [
      {
        id: 'WEB-70',
        title: 'PDF export pipeline',
        ws: 'eng-portal',
        pri: 'P1',
        sub: 'failed · implement',
        age: '1h',
        failed: true,
        badges: [
          { label: 'failed', tone: 'danger', loud: true },
          { label: 'retry ready', tone: 'danger' },
        ],
      },
      {
        id: 'SR-0129',
        title: 'Teams SSO mapping',
        ws: 'team-a',
        pri: 'P2',
        sub: 'changes-requested',
        age: '3h',
        badges: [{ label: '2 findings', tone: 'mint' }],
      },
      {
        id: 'SR-0133',
        title: 'Stripe metered billing',
        ws: 'team-a',
        pri: 'P1',
        sub: 'in-progress',
        age: '22m',
        badges: [],
        run: 'impl · step 4/9',
      },
    ],
  },
  {
    name: 'Review',
    wip: 4,
    cards: [
      {
        id: 'SR-0125',
        title: 'Usage dashboard',
        ws: 'team-a',
        pri: 'P1',
        sub: 'pr-open',
        age: '1h',
        badges: [
          { label: 'review', tone: 'mint' },
          { label: 'CI 5/6', tone: 'blue' },
        ],
      },
      {
        id: 'SR-0127',
        title: 'Webhook retries',
        ws: 'eng-portal',
        pri: 'P2',
        sub: 'ci-watch',
        age: '4h',
        badges: [{ label: 'CI running', tone: 'blue' }],
      },
    ],
  },
  {
    name: 'Done',
    cards: [
      {
        id: 'SR-0120',
        title: 'Dark mode polish',
        ws: 'team-a',
        pri: 'P2',
        sub: 'merged',
        age: '2h',
        badges: [],
      },
      {
        id: 'SR-0118',
        title: 'Embed auth refresh',
        ws: 'team-a',
        pri: 'P1',
        sub: 'merged',
        age: '1d',
        badges: [],
      },
      {
        id: 'WEB-60',
        title: 'Legacy IE support',
        ws: 'eng-portal',
        pri: 'P3',
        sub: 'wont-do',
        age: '3d',
        badges: [],
      },
    ],
    more: 14,
  },
];

function BoardCardView({ card }: { card: BoardCard }) {
  return (
    <NavLink
      className={`d-card${card.failed ? ' failed' : ''}`}
      to={demoPath(`/tickets/${card.ws}/${card.id}`)}
    >
      <div className="d-card-top">
        <span className="d-card-id mono">{card.id}</span>
        <span className={`d-card-pri ${card.pri === 'P0' ? 'd-red' : ''}`}>
          {card.pri}
        </span>
        {card.claim && <span className="d-card-claim">{card.claim}</span>}
      </div>
      <div className="d-card-title">{card.title}</div>
      <div className="d-card-sub mono">{card.sub}</div>
      {card.badges.length > 0 && (
        <div className="d-card-badges">
          {card.badges.map((b) => (
            <span
              key={b.label}
              className={`d-badge d-${b.tone}${b.loud ? ' loud' : ''}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}
      <div className="d-card-meta">
        <span>{card.ws}</span>
        <span>{card.age}</span>
        {card.run && (
          <span className="d-card-run">
            <i /> {card.run}
          </span>
        )}
      </div>
    </NavLink>
  );
}

function BoardTab({ empty = false }: { empty?: boolean }) {
  return (
    <>
      <div className="d-toolbar">
        <button type="button">
          <PanelLeft size={14} /> All workspaces <ChevronDown size={13} />
        </button>
        <span className="d-check">
          <span className="d-checkbox" /> Only my moves
        </span>
        <span className="d-flex-spacer" />
        <span className="d-live">
          <i /> Live
        </span>
        <span className="d-updated">Updated 8s ago</span>
      </div>
      {!empty && (
        <div className="d-ops-strip">
          <Zap size={13} />
          <span>Ops:</span>
          <button type="button">survey:web-app · dossier ready</button>
          <button type="button">import:GH-42 · awaiting confirm</button>
        </div>
      )}
      {empty && (
        <div className="d-board-empty-state">
          <span className="d-empty-icon">
            <Ticket size={20} />
          </span>
          <div>
            <strong>No tickets match this view</strong>
            <p>
              Clear the active filters, import an issue, or describe the next
              outcome you want Veto to move forward.
            </p>
          </div>
          <Button variant="quiet">Clear filters</Button>
          <Button variant="primary" icon={<Plus size={13} />}>
            Create or import
          </Button>
        </div>
      )}
      <div className="d-board">
        {boardColumns.map((col) => {
          const cards = empty ? [] : col.cards;
          const over = col.wip !== undefined && cards.length > col.wip;
          return (
            <section
              className={`d-col${empty ? ' empty' : ''}`}
              key={col.name}
              aria-label={`${col.name} tickets`}
            >
              <div className="d-col-head">
                <span className="d-col-name">{col.name}</span>
                <span className={`d-col-count${over ? ' warn' : ''}`}>
                  {cards.length}
                  {col.wip !== undefined && ` / ${col.wip}`}
                </span>
                {over && <span className="d-col-wip">over WIP</span>}
              </div>
              {cards.map((card) => (
                <BoardCardView key={card.id} card={card} />
              ))}
              {empty && (
                <div className="d-col-empty">
                  <Circle size={13} />
                  <span>No tickets</span>
                </div>
              )}
              {!empty && col.more !== undefined && (
                <button type="button" className="d-col-more">
                  and {col.more} more
                </button>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

function GatePanel({ card }: { card: BoardCard }) {
  if (card.id === 'SR-0142')
    return (
      <Panel className="d-next-action-panel">
        <SectionHeader title="Next action" meta="waiting on you · Q&A" />
        <p className="d-focus-q">Which cache backend should sessions use?</p>
        {[
          ['A', 'Redis — shared, TTL-native', true],
          ['B', 'In-process LRU — zero deps', false],
          ['C', 'Postgres table — audit-friendly', false],
        ].map(([key, label, rec]) => (
          <div className="d-focus-opt" key={key as string}>
            <span className="mono">{key}</span>
            <span>{label}</span>
            {rec === true && <Badge tone="mint">★ rec</Badge>}
          </div>
        ))}
        <div className="d-focus-actions">
          <Button variant="primary">Answer</Button>
          <Button variant="quiet">Skip = accept rec</Button>
        </div>
      </Panel>
    );
  if (card.failed)
    return (
      <Panel className="d-next-action-panel">
        <SectionHeader
          title="Next action"
          meta="recovery required · implement"
        />
        <p className="d-focus-q">
          Implement run failed — sandbox timeout at verify step. Worktree
          preserved.
        </p>
        <div className="d-focus-actions">
          <Button variant="primary">Retry</Button>
          <Button variant="quiet">Edit + retry</Button>
          <Button variant="danger">Won't do</Button>
        </div>
      </Panel>
    );
  if (card.badges.some((b) => b.tone === 'blue'))
    return (
      <Panel className="d-next-action-panel">
        <SectionHeader title="Next action" meta="waiting on you · approval" />
        <p className="d-focus-q">{card.sub} is ready for review.</p>
        <div className="d-focus-actions">
          <Button variant="primary">Approve</Button>
          <Button variant="quiet">Request changes</Button>
        </div>
      </Panel>
    );
  return (
    <Panel className="d-next-action-panel">
      <SectionHeader title="Next action" meta="Veto is working" />
      <div className="d-next-working">
        <span className="d-next-working-icon">
          <Activity size={16} />
        </span>
        <div>
          <strong>Implementation is in progress</strong>
          <p>
            Veto is adding the billing ledger adapter, then it will run the
            approved test plan.
          </p>
          <div className="d-next-progress">
            <i style={{ width: '44%' }} />
          </div>
          <small>Step 4 of 9 · last activity 18s ago</small>
        </div>
        <Button variant="quiet" icon={<SquareTerminal size={13} />}>
          Watch run
        </Button>
      </div>
    </Panel>
  );
}

const fallbackCard: BoardCard = {
  id: 'SR-0142',
  title: 'Session cache backend',
  ws: 'team-a',
  pri: 'P1',
  sub: 'needs-info',
  age: '2h',
  badges: [{ label: 'Q&A', tone: 'purple' }],
  claim: 'KG',
};

const focusDocs: Array<[string, string, string, string, Tone]> = [
  ['prd.md', 'v3', 'approved', '3h ago', 'blue'],
  ['tdd.md', 'v2', 'in review', '5h ago', 'blue'],
  ['test.md', 'v1', 'draft', '1d ago', 'neutral'],
];

const focusLedger = [
  ['14:02', 'gate_surfaced', 'needs-info · 2 questions'],
  ['13:41', 'doc_approved', 'prd.md v3 · by KG'],
  ['13:22', 'run_finished', 'prd-revise · 31k/8k tok · $0.41'],
  ['12:58', 'doc_feedback', '§Req-4 comment → revision run'],
  ['11:30', 'status_changed', 'imported → triage'],
  ['11:04', 'run_finished', 'triage · spec-score 62'],
];

const focusRuns = [
  ['prd-revise', 'devin · main_model', 'done · 6m', '31k/8k'],
  ['triage', 'devin · main_model', 'done · 2m', '12k/3k'],
];

interface FocusDetails {
  summary: string;
  score: number;
  repos: string;
  branch: string;
  package: Array<[string, string, Tone]>;
  evidence: Array<[string, string]>;
  proposedEdit?: [string, string];
}

const fallbackFocusDetails: FocusDetails = {
  summary:
    'Move session state from process memory to a shared cache so routine API deployments do not sign users out.',
  score: 62,
  repos: 'api, web',
  branch: 'feat/SR-0142',
  package: [
    ['ticket.md', 'v2 · ready', 'mint'],
    ['triage.json', 'needs 2 answers', 'purple'],
    ['prior art', 'SR-0091 linked', 'blue'],
  ],
  evidence: [
    ['14:02', 'Q&A gate surfaced · 2 questions'],
    ['13:41', 'Triage completed · 6 acceptance risks'],
    ['13:22', 'Prior art matched · 4 overlapping files'],
  ],
  proposedEdit: [
    '+ AC3: cache hit rate ≥ 80% on /session reads',
    '- AC3: sessions must be fast',
  ],
};

const focusDetails: Record<string, FocusDetails> = {
  'SR-0142': fallbackFocusDetails,
  'SR-0133': {
    summary:
      'Emit idempotent Stripe usage records from finalized invoices and reconcile every record against the billing ledger.',
    score: 88,
    repos: 'api, billing',
    branch: 'feat/SR-0133',
    package: [
      ['PRD.md', 'v3 · approved', 'mint'],
      ['TDD.md', 'v2 · approved', 'mint'],
      ['TEST.md', 'v2 · 14 cases', 'blue'],
    ],
    evidence: [
      ['14:18', 'Implement run · step 4 of 9'],
      ['14:06', '7 unit tests added · all passing'],
      ['13:52', 'Worktree created · billing repo'],
    ],
  },
};

function spotlightTab(card: BoardCard): string | null {
  if (card.failed) return 'Failure';
  if (card.sub === 'split-plan') return 'Split plan';
  if (
    ['approved', 'pr-open', 'ci-watch', 'changes-requested'].includes(card.sub)
  )
    return 'Code review';
  return null;
}

const focusRoadmap = [
  ['Ticket definition', 'Clarify the outcome and acceptance criteria'],
  ['Product requirements', 'Approve the PRD'],
  ['Technical design', 'Approve the TDD'],
  ['Test plan', 'Approve coverage before implementation'],
  ['Implementation', 'Build and verify the change'],
  ['Code review', 'Resolve findings and approve the code'],
  ['Merge and release', 'Pass checks and merge'],
] as const;

function focusStep(card: BoardCard, phase?: string) {
  if (phase === 'Done') return focusRoadmap.length;
  if (phase === 'Review') return 5;
  if (phase === 'Build') return 4;
  if (phase === 'Spec') {
    if (card.sub.includes('test')) return 3;
    if (card.sub.includes('tdd')) return 2;
    return 1;
  }
  return 0;
}

function focusStatus(phase?: string) {
  if (phase === 'Spec') return 'Documentation';
  if (phase === 'Build') return 'Development';
  if (phase === 'Review') return 'Code review & release';
  if (phase === 'Done') return 'Complete';
  return 'Ticket definition';
}

function nextStepCopy(card: BoardCard, phase?: string) {
  if (card.id === 'SR-0142')
    return {
      owner: 'Waiting on you',
      action: 'Choose the session cache backend',
    };
  if (card.failed)
    return { owner: 'Waiting on you', action: 'Choose a recovery path' };
  if (card.badges.some((badge) => badge.tone === 'blue'))
    return { owner: 'Waiting on you', action: `Review ${card.sub}` };
  if (phase === 'Done')
    return { owner: 'No action needed', action: 'Work is complete' };
  return {
    owner: 'Veto is working',
    action: 'Finish implementation and run the test plan',
  };
}

function TicketFocusScreen() {
  const { ws = '', id = '' } = useParams();
  const card = boardColumns
    .flatMap((c) => c.cards)
    .find((x) => x.id === id) ?? { ...fallbackCard, id, ws };
  const details = focusDetails[card.id] ?? fallbackFocusDetails;
  const current = boardColumns.find((c) =>
    c.cards.some((x) => x.id === card.id),
  )?.name;
  const currentStep = focusStep(card, current);
  const status = focusStatus(current);
  const nextStep = nextStepCopy(card, current);
  const docs =
    card.id === 'SR-0133'
      ? ([
          ['prd.md', 'v3', 'approved', '2h ago', 'mint'],
          ['tdd.md', 'v2', 'approved', '3h ago', 'mint'],
          ['test.md', 'v2', '14 cases', '3h ago', 'blue'],
        ] satisfies Array<[string, string, string, string, Tone]>)
      : focusDocs;
  const documentPreview =
    card.id === 'SR-0133'
      ? {
          title: 'Stripe metered billing',
          summary:
            'Emit idempotent Stripe usage records from finalized invoices and reconcile each record against the billing ledger.',
          criteria: [
            'A finalized invoice emits exactly one usage record.',
            'Retries reuse the same idempotency key.',
            'Every Stripe record reconciles to a ledger entry.',
          ],
        }
      : {
          title: 'Shared session cache',
          summary:
            'Preserve authenticated sessions across routine API deploys by moving session state into a shared, TTL-aware cache.',
          criteria: [
            'Existing sessions survive a rolling deployment.',
            'Session expiration remains configurable per workspace.',
            'Cache failures produce an observable, safe fallback.',
          ],
        };
  const spotlight = spotlightTab(card);
  const tabs = [
    { label: 'Overview' },
    { label: 'Documentation' },
    ...(spotlight ? [{ label: spotlight }] : []),
    { label: 'Activity' },
    { label: 'Runs' },
  ];
  const [tab, setTab] = useState('Overview');
  return (
    <div className="d-page d-focus-page">
      <PageHeader
        eyebrow={
          <NavLink to={demoPath('/')} className="d-back">
            <ArrowLeft size={13} /> Board
          </NavLink>
        }
        title={`${card.id} — ${card.title}`}
        description={`${card.ws} · ${card.pri} · updated ${card.age} ago`}
        meta={
          <Badge
            tone={card.failed ? 'danger' : current === 'Done' ? 'mint' : 'blue'}
            dot
          >
            {status} · {card.sub}
          </Badge>
        }
        actions={
          <>
            <Button variant="quiet" icon={<SquareTerminal size={13} />}>
              Run monitor
            </Button>
            <Button variant="quiet" icon={<ListChecks size={13} />}>
              Full ledger
            </Button>
          </>
        }
      />
      <div className="d-focus-grid">
        <div className="d-focus-main">
          <GatePanel card={card} />
          <Tabs items={tabs} active={tab} onChange={setTab} />
          {tab === 'Overview' && (
            <div className="d-focus-overview">
              <Panel>
                <SectionHeader
                  title="Ticket definition"
                  meta="ticket.md · v2"
                  action={
                    <div className="d-inline-actions">
                      <button type="button">Edit</button>
                      <button type="button" className="d-ai-action">
                        <Sparkles size={11} /> Improve with AI
                      </button>
                    </div>
                  }
                />
                <p className="d-focus-md">{details.summary}</p>
                <div className="d-focus-facts">
                  <span>spec ◐ {details.score}</span>
                  <span>repos: {details.repos}</span>
                  <span>branch {details.branch}</span>
                </div>
              </Panel>
              <div className="d-focus-overview-grid">
                <Panel>
                  <SectionHeader title="Specification package" />
                  <div className="d-focus-mini-list">
                    {details.package.map(([name, state, tone]) => (
                      <div key={name}>
                        <FileText size={13} />
                        <span className="mono">{name}</span>
                        <Badge tone={tone}>{state}</Badge>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel>
                  <SectionHeader title="Recent evidence" />
                  <div className="d-focus-mini-list">
                    {details.evidence.map(([time, event]) => (
                      <div key={`${time}-${event}`}>
                        <Activity size={13} />
                        <span>{event}</span>
                        <time>{time}</time>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            </div>
          )}
          {tab === 'Code review' && (
            <Panel>
              <SectionHeader title="Review brief" meta="review · S-08" />
              <div className="d-focus-brief">
                <Metric label="Diffstat" value="+412 −87" />
                <Metric label="Findings" value="2 open" tone="warning" />
                <Metric label="Tests" value="11/12" tone="mint" />
              </div>
              <div className="d-focus-actions">
                <Button variant="primary" icon={<Code2 size={13} />}>
                  Open full code review
                </Button>
              </div>
            </Panel>
          )}
          {tab === 'Failure' && (
            <Panel>
              <SectionHeader title="Failure detail" meta="implement" />
              <p className="d-focus-md">
                Sandbox timeout at verify step after 30m. Worktree + branch
                preserved at feat/WEB-70.
              </p>
              <div className="d-focus-diff mono">
                <span>verify: pnpm test → ETIMEDOUT</span>
                <span>class: env · not agent error</span>
              </div>
            </Panel>
          )}
          {tab === 'Documentation' && (
            <div className="d-document-workbench">
              <Panel className="d-document-list">
                <SectionHeader title="Documentation" meta="versioned" />
                {docs.map(([name, ver, docStatus, updated, tone], index) => (
                  <button
                    type="button"
                    className={`d-doc-select${index === 0 ? ' selected' : ''}`}
                    key={name}
                  >
                    <FileText size={14} />
                    <span>
                      <strong className="mono">{name}</strong>
                      <small>
                        {docStatus} · {updated}
                      </small>
                    </span>
                    <Badge tone={tone}>{ver}</Badge>
                  </button>
                ))}
              </Panel>
              <Panel className="d-document-editor">
                <SectionHeader
                  title="prd.md"
                  meta="v3 · approved"
                  action={
                    <div className="d-inline-actions">
                      <button type="button">History</button>
                      <button type="button">Edit</button>
                    </div>
                  }
                />
                <article className="d-doc-preview">
                  <span className="d-doc-kicker">Product requirements</span>
                  <h3>{documentPreview.title}</h3>
                  <p>{documentPreview.summary}</p>
                  <h4>Acceptance criteria</h4>
                  <ul>
                    {documentPreview.criteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </article>
                <div className="d-context-ai">
                  <span className="d-context-ai-icon">
                    <Sparkles size={14} />
                  </span>
                  <div>
                    <strong>Revise with Veto</strong>
                    <small>
                      Ask for a change. Veto proposes a diff; you approve before
                      a new version is saved.
                    </small>
                  </div>
                  <input
                    aria-label="Ask Veto to revise this document"
                    placeholder="Add failure-mode requirements…"
                  />
                  <Button variant="primary">Propose edit</Button>
                </div>
              </Panel>
            </div>
          )}
          {tab === 'Activity' && (
            <Panel>
              <SectionHeader title="Ledger" meta="events" />
              {focusLedger.map(([ts, ev, detail]) => (
                <div className="d-focus-act" key={`${ts}-${ev}`}>
                  <span className="mono d-focus-meta">{ts}</span>
                  <span className="mono">{ev}</span>
                  <span>{detail}</span>
                </div>
              ))}
              <div className="d-focus-actions">
                <Button variant="quiet" icon={<ListChecks size={13} />}>
                  Open full ledger
                </Button>
              </div>
            </Panel>
          )}
          {tab === 'Runs' && (
            <Panel>
              <SectionHeader title="Runs" meta={`${focusRuns.length}`} />
              {focusRuns.map(([name, engine, status, tokens]) => (
                <div className="d-focus-act" key={name}>
                  <span className="mono">{name}</span>
                  <span>{engine}</span>
                  <span className="d-focus-meta">{status}</span>
                  <span className="d-focus-meta mono">{tokens} tok</span>
                </div>
              ))}
            </Panel>
          )}
        </div>
        <aside className="d-focus-rail">
          <Panel className="d-status-panel">
            <SectionHeader title="Status" meta={card.sub} />
            <div className="d-status-current">
              <span>Current phase</span>
              <strong>{status}</strong>
            </div>
            <div className="d-status-next">
              <span>{nextStep.owner}</span>
              <strong>{nextStep.action}</strong>
            </div>
          </Panel>
          <Panel className="d-roadmap-panel">
            <SectionHeader title="What’s left" />
            <div className="d-roadmap">
              {focusRoadmap.map(([label, description], index) => {
                const complete = index < currentStep;
                const active = index === currentStep;
                return (
                  <div
                    className={`d-roadmap-step${complete ? ' complete' : ''}${active ? ' active' : ''}`}
                    key={label}
                  >
                    <span className="d-roadmap-marker">
                      {complete ? <Check size={11} /> : index + 1}
                    </span>
                    <div>
                      <strong>{label}</strong>
                      {(active || index === currentStep + 1) && (
                        <small>{description}</small>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Key facts" />
            <div className="d-focus-fact">
              <span>Workspace</span>
              <span>{card.ws}</span>
            </div>
            <div className="d-focus-fact">
              <span>Priority</span>
              <span>{card.pri}</span>
            </div>
            <div className="d-focus-fact">
              <span>Spec score</span>
              <span
                className={`d-score ${details.score >= 75 ? 'good' : 'mid'}`}
              >
                ◐ {details.score}
              </span>
            </div>
            <div className="d-focus-fact">
              <span>Branch</span>
              <span className="mono">{details.branch}</span>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function HomeScreen() {
  const [tab, setTab] = useState('Board');
  const location = useLocation();
  const empty =
    new URLSearchParams(location.search).get('scenario') === 'empty';
  return (
    <div className="d-page d-home-page">
      <PageHeader
        title="Home"
        description="Where every ticket stands — and what's left to do."
        meta={
          <Badge tone="warning" dot>
            {empty ? '0 open' : '9 open'}
          </Badge>
        }
        actions={
          <Button variant="quiet" icon={<RefreshCw size={14} />}>
            Refresh
          </Button>
        }
      />
      <Tabs
        items={[{ label: 'Board' }, { label: 'Inbox', count: empty ? 0 : 9 }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'Board' ? <BoardTab empty={empty} /> : <InboxContent />}
    </div>
  );
}

function Field({
  label,
  value,
  help,
  wide = false,
}: {
  label: string;
  value: string;
  help?: string;
  wide?: boolean;
}) {
  return (
    <label className={wide ? 'd-form-field d-field-wide' : 'd-form-field'}>
      <span>{label}</span>
      <input value={value} readOnly />
      {help && <small>{help}</small>}
    </label>
  );
}

function Toggle({ on = true }: { on?: boolean }) {
  return (
    <span className={`d-toggle ${on ? 'on' : ''}`}>
      <i />
    </span>
  );
}

function SettingsScreen() {
  const [tab, setTab] = useState('Models');
  return (
    <div className="d-page">
      <PageHeader
        title="Settings"
        description="Global defaults for agents, governance, and connected workspaces."
        meta={
          <Badge tone="mint" dot>
            configuration valid
          </Badge>
        }
        actions={
          <Button variant="primary" icon={<Check size={14} />}>
            Save changes
          </Button>
        }
      />
      <Tabs
        items={[
          'Models',
          'Pipeline',
          'Products',
          'Security',
          'Notifications',
        ].map((label) => ({ label }))}
        active={tab}
        onChange={setTab}
      />
      <div className="d-settings-layout">
        <div className="d-settings-main">
          <Panel>
            <SectionHeader
              title="Agent runtime"
              meta="Inherited by all workspaces"
              action={<Badge tone="blue">global</Badge>}
            />
            <div className="d-form-grid">
              <Field
                label="Backend"
                value="devin"
                help="Detected from the Devin.app bundle"
              />
              <Field
                label="Permission mode"
                value="smart"
                help="Pauses before risky operations"
              />
              <Field
                label="Main model"
                value="GPT-5.6 Sol"
                help="Implementation and specification work"
              />
              <Field
                label="Review model"
                value="GPT-5.6 Sol"
                help="Use an independent pass in production"
              />
              <Field
                label="Escalation model"
                value="GPT-5.6 Sol · high"
                help="Retry ladder and ambiguity resolution"
              />
              <Field
                label="Actor identity"
                value="veto-bot@team-a"
                help="Machine commits and event attribution"
              />
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Guardrails" meta="Fail-closed by default" />
            <div className="d-setting-rows">
              <div>
                <ShieldCheck size={16} />
                <span>
                  <strong>Require spec approval</strong>
                  <small>PRD, TDD, and test plan remain human gates.</small>
                </span>
                <Toggle />
              </div>
              <div>
                <LockKeyhole size={16} />
                <span>
                  <strong>Spend checkpoint</strong>
                  <small>
                    Implementation starts only after the operator accepts the
                    estimate.
                  </small>
                </span>
                <Toggle />
              </div>
              <div>
                <GitMerge size={16} />
                <span>
                  <strong>Merge strategy</strong>
                  <small>
                    Squash commits after checks and review findings clear.
                  </small>
                </span>
                <Badge>Squash</Badge>
              </div>
            </div>
          </Panel>
        </div>
        <aside className="d-settings-rail">
          <Panel>
            <SectionHeader title="Runtime status" />
            <div className="d-health-list">
              <div>
                <CheckCircle2 size={14} />
                <span>git</span>
                <code>2.50.1</code>
              </div>
              <div>
                <CheckCircle2 size={14} />
                <span>gh</span>
                <code>2.80.0</code>
              </div>
              <div>
                <AlertTriangle size={14} />
                <span>gitleaks</span>
                <Badge tone="danger">missing</Badge>
              </div>
              <div>
                <CheckCircle2 size={14} />
                <span>devin</span>
                <Badge tone="mint">bundle</Badge>
              </div>
              <div>
                <AlertTriangle size={14} />
                <span>aider</span>
                <Badge tone="warning">missing</Badge>
              </div>
            </div>
          </Panel>
          <Panel className="d-callout d-callout-warning">
            <AlertTriangle size={17} />
            <div>
              <strong>One blocking dependency</strong>
              <p>
                gitleaks is required before Veto can commit ticket artifacts.
              </p>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Config source" />
            <code className="d-code-path">~/.config/veto/config.yaml</code>
            <div className="d-version-row">
              <span>Schema</span>
              <Badge>v1</Badge>
            </div>
            <div className="d-version-row">
              <span>Last saved</span>
              <span>2 min ago</span>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function CreateImportScreen() {
  const [tab, setTab] = useState('Describe an idea');
  return (
    <div className="d-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> Inbox
          </span>
        }
        title="Create work"
        description="Start with rough intent. The interview will turn it into a verifiable ticket."
      />
      <Tabs
        items={[
          { label: 'Describe an idea' },
          { label: 'GitHub issue' },
          { label: 'CSV import' },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="d-create-layout">
        <Panel className="d-create-form">
          <div className="d-kicker">
            <WandSparkles size={15} /> Interview seed
          </div>
          <h2>What should change?</h2>
          <p className="d-muted">
            Write naturally. Veto will ask only for details that materially
            affect the implementation.
          </p>
          <textarea
            readOnly
            value="Users are getting signed out when the API deployment rolls. Move sessions out of process memory so deploys are invisible to signed-in users."
          />
          <div className="d-prompt-tools">
            <button type="button">
              <Mic size={14} /> Dictate
            </button>
            <span className="d-flex-spacer" />
            <span>142 characters</span>
          </div>
          <div className="d-form-grid d-compact-form">
            <Field label="Workspace" value="team-a" />
            <Field label="Priority" value="P1 · high" />
            <Field label="Product" value="myApp" />
            <Field label="Likely repos" value="backend, web" />
          </div>
          <div className="d-callout-inline">
            <Sparkles size={15} />
            <span>
              <strong>Related prior art found</strong> · SR-0091 “Redis
              rate-limit state” touches 4 of the same files.
            </span>
            <button type="button">Review</button>
          </div>
          <div className="d-form-actions">
            <span>Creates a draft before the interview starts.</span>
            <Button variant="primary" icon={<ArrowRight size={14} />}>
              Start interview
            </Button>
          </div>
        </Panel>
        <aside className="d-create-preview">
          <Panel>
            <div className="d-preview-top">
              <Badge tone="purple">draft preview</Badge>
              <span className="mono">SR-0142</span>
            </div>
            <h3>Persist sessions across API deployments</h3>
            <p>
              Move session state from process memory to a shared cache without
              changing the sign-in experience.
            </p>
            <div className="d-preview-spec">
              <ProgressRing value={62} tone="warning" />
              <div>
                <strong>Spec readiness</strong>
                <span>4 important details remain unknown</span>
              </div>
            </div>
            <ul className="d-check-list">
              <li className="done">
                <Check size={13} /> Problem and user impact
              </li>
              <li className="done">
                <Check size={13} /> Likely code surfaces
              </li>
              <li>
                <Circle size={12} /> Cache technology
              </li>
              <li>
                <Circle size={12} /> Migration and rollback
              </li>
              <li>
                <Circle size={12} /> Session lifetime behavior
              </li>
            </ul>
          </Panel>
          <div className="d-flow-note">
            <Workflow size={16} />
            <span>
              <strong>Next:</strong> 4–6 focused questions, then triage and a
              PRD proposal.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

const answerOptions: Array<[string, string, boolean]> = [
  [
    'Redis via the existing platform service',
    'Reuses monitored infrastructure and matches prior art.',
    true,
  ],
  [
    'PostgreSQL session table',
    'Fewer services, but adds write load and cleanup work.',
    false,
  ],
  [
    'Signed stateless cookies',
    'Removes server state but changes revocation semantics.',
    false,
  ],
];

function WizardScreen() {
  const [selected, setSelected] = useState(0);
  return (
    <div className="d-page d-wizard-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> SR-0142
          </span>
        }
        title="Resolve specification questions"
        description="Answer what changes the design. Veto will record every decision in the ticket ledger."
        meta={<Badge tone="purple">question 3 of 5</Badge>}
        actions={<Button variant="quiet">Save and exit</Button>}
      />
      <div className="d-progress">
        <span style={{ width: '60%' }} />
      </div>
      <div className="d-wizard-layout">
        <Panel className="d-question-card">
          <div className="d-question-number mono">Q03 · ARCHITECTURE</div>
          <h2>Which cache backend should hold session state?</h2>
          <p className="d-question-why">
            <MessageCircleQuestion size={15} /> This determines failure
            behavior, deployment work, and the shape of the migration plan.
          </p>
          <div className="d-answer-list">
            {answerOptions.map(([title, detail, recommended], index) => (
              <button
                type="button"
                key={title}
                className={selected === index ? 'selected' : ''}
                onClick={() => setSelected(index)}
              >
                <span className="d-radio">{selected === index && <i />}</span>
                <span>
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </span>
                {recommended && (
                  <Badge tone="mint">
                    <Sparkles size={11} /> recommended
                  </Badge>
                )}
              </button>
            ))}
            <button type="button" className="d-other-answer">
              <span className="d-radio" />
              <span>
                <strong>Other</strong>
                <small>Write a different answer.</small>
              </span>
            </button>
          </div>
          <label className="d-answer-note">
            <span>Decision note · optional</span>
            <textarea
              value="Use the managed Redis cluster in us-central1. Preserve the current 12-hour idle timeout."
              readOnly
            />
          </label>
          <div className="d-wizard-actions">
            <Button variant="quiet" icon={<ArrowLeft size={14} />}>
              Previous
            </Button>
            <span className="d-flex-spacer" />
            <Button variant="primary" icon={<ArrowRight size={14} />}>
              Record and continue
            </Button>
          </div>
        </Panel>
        <aside className="d-wizard-rail">
          <Panel>
            <SectionHeader title="Ticket context" />
            <strong className="mono">SR-0142</strong>
            <h3>Persist sessions across API deployments</h3>
            <div className="d-mini-meta">
              <Badge tone="danger">P1 high</Badge>
              <Badge>team-a</Badge>
            </div>
            <div className="d-context-stats">
              <span>Spec readiness</span>
              <strong className="mono">62 / 100</strong>
            </div>
            <div className="d-mini-progress">
              <i style={{ width: '62%' }} />
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Why this is recommended" />
            <p className="d-muted">
              The backend already uses the platform Redis service for rate-limit
              state. The dossier marks it as owned and production-ready.
            </p>
            <button type="button" className="d-text-link">
              View supporting evidence <ArrowRight size={13} />
            </button>
          </Panel>
          <div className="d-bailouts">
            <button type="button">
              <Zap size={14} /> Accept all recommended
            </button>
            <button type="button">
              <TimerReset size={14} /> Force ready
            </button>
            <button type="button">
              <X size={14} /> Won’t do
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

const stages = [
  ['Imported', 'done'],
  ['Triage', 'done'],
  ['Questions', 'done'],
  ['PRD', 'done'],
  ['TDD', 'done'],
  ['Test plan', 'current'],
  ['Implement', 'next'],
  ['Review', 'next'],
  ['PR', 'next'],
];

function StageTimeline() {
  return (
    <div className="d-stage-line">
      {stages.map(([label, state]) => (
        <div className={`d-stage-step ${state}`} key={label}>
          <i>{state === 'done' ? <Check size={10} /> : null}</i>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function TicketDetailScreen() {
  return (
    <div className="d-page d-ticket-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> Tickets / team-a
          </span>
        }
        title="Persist sessions across API deployments"
        description="Move session state to a shared cache without changing the sign-in experience."
        meta={
          <>
            <span className="mono d-ticket-id">SR-0142</span>
            <Badge tone="blue">test-plan-review</Badge>
          </>
        }
        actions={
          <>
            <Button variant="quiet" icon={<MoreHorizontal size={14} />}>
              More
            </Button>
            <Button variant="primary" icon={<Play size={14} />}>
              Approve test plan
            </Button>
          </>
        }
      />
      <StageTimeline />
      <div className="d-ticket-layout">
        <div className="d-ticket-main">
          <Panel className="d-decision-panel">
            <div className="d-decision-icon">
              <ListChecks size={19} />
            </div>
            <div>
              <Badge tone="blue">your decision</Badge>
              <h2>Test plan v2 is ready</h2>
              <p>
                17 cases cover all six acceptance criteria. One staging-only
                case is marked for manual verification.
              </p>
            </div>
            <Button variant="primary" icon={<ArrowRight size={14} />}>
              Review test plan
            </Button>
          </Panel>
          <Panel>
            <SectionHeader
              title="Specification package"
              meta="3 documents · 2 approved"
              action={
                <button type="button" className="d-text-link">
                  Open folder <ArrowRight size={13} />
                </button>
              }
            />
            <div className="d-doc-list">
              {[
                [
                  'PRD.md',
                  'Product requirements',
                  'v3',
                  'approved',
                  '6 ACs · score 91',
                ],
                [
                  'TDD.md',
                  'Technical design',
                  'v2',
                  'approved',
                  'Redis · dual-read migration',
                ],
                [
                  'TEST.md',
                  'Test plan',
                  'v2',
                  'awaiting you',
                  '17 cases · 94% mapped',
                ],
              ].map((doc) => (
                <NavLink
                  key={doc[0]}
                  to={demoPath('/tickets/team-a/SR-0142/docs/prd.md')}
                >
                  <FileText size={17} />
                  <span>
                    <strong>{doc[0]}</strong>
                    <small>{doc[1]}</small>
                  </span>
                  <code>{doc[2]}</code>
                  <Badge tone={doc[3] === 'approved' ? 'mint' : 'blue'}>
                    {doc[3]}
                  </Badge>
                  <em>{doc[4]}</em>
                  <ChevronRight size={14} />
                </NavLink>
              ))}
            </div>
          </Panel>
          <Panel>
            <SectionHeader
              title="Recent activity"
              action={
                <NavLink
                  className="d-text-link"
                  to={demoPath('/tickets/team-a/SR-0142/ledger')}
                >
                  Full ledger <ArrowRight size={13} />
                </NavLink>
              }
            />
            <div className="d-activity-feed">
              <div>
                <i className="mint">
                  <Check size={11} />
                </i>
                <span>
                  <strong>TDD approved</strong>
                  <small>Keith Goff · 42 min ago</small>
                </span>
                <code>evt_08fb</code>
              </div>
              <div>
                <i className="purple">
                  <MessageSquare size={11} />
                </i>
                <span>
                  <strong>Architecture answer recorded</strong>
                  <small>
                    Redis via the existing platform service · 1h ago
                  </small>
                </span>
                <code>evt_07ae</code>
              </div>
              <div>
                <i className="blue">
                  <Sparkles size={11} />
                </i>
                <span>
                  <strong>Test plan generated</strong>
                  <small>GPT-5.6 Sol · 18.4k tokens · 1h ago</small>
                </span>
                <code>run_tp_142</code>
              </div>
            </div>
          </Panel>
        </div>
        <aside className="d-ticket-rail">
          <Panel>
            <SectionHeader title="Properties" />
            <dl className="d-property-list">
              <div>
                <dt>Priority</dt>
                <dd>
                  <Badge tone="danger">P1 high</Badge>
                </dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>team-a</dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd>myApp</dd>
              </div>
              <div>
                <dt>Depth</dt>
                <dd>standard</dd>
              </div>
              <div>
                <dt>Spec score</dt>
                <dd>
                  <ProgressRing value={91} />
                </dd>
              </div>
            </dl>
          </Panel>
          <Panel>
            <SectionHeader title="Repositories" />
            <div className="d-repo-row">
              <FolderGit2 size={15} />
              <span>
                <strong>backend</strong>
                <small>4 files expected</small>
              </span>
              <Badge tone="mint">ready</Badge>
            </div>
            <div className="d-repo-row">
              <FolderGit2 size={15} />
              <span>
                <strong>web</strong>
                <small>2 files expected</small>
              </span>
              <Badge tone="mint">ready</Badge>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Family" meta="1 related" />
            <div className="d-family-item">
              <GitBranch size={14} />
              <span>
                <code>SR-0091</code>
                <small>Redis rate-limit state</small>
              </span>
              <Badge>prior art</Badge>
            </div>
          </Panel>
          <Panel className="d-cost-panel">
            <span>Spent so far</span>
            <strong className="mono">$4.82</strong>
            <small>68.1k tokens · 6 runs</small>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function DocReviewScreen() {
  const [tab, setTab] = useState('Rendered');
  return (
    <div className="d-page d-doc-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> SR-0142 / Documents
          </span>
        }
        title="PRD.md"
        description="Product requirements · version 3"
        meta={
          <>
            <Badge tone="mint">score 91</Badge>
            <Badge tone="blue">awaiting approval</Badge>
          </>
        }
        actions={
          <>
            <Button variant="quiet" icon={<MessageSquare size={14} />}>
              Add comment
            </Button>
            <Button variant="primary" icon={<Check size={14} />}>
              Approve PRD
            </Button>
          </>
        }
      />
      <div className="d-doc-toolbar">
        <Tabs
          items={[
            { label: 'Rendered' },
            { label: 'Changes', count: 12 },
            { label: 'Coverage', count: 6 },
          ]}
          active={tab}
          onChange={setTab}
        />
        <span className="d-flex-spacer" />
        <button type="button">
          v3 <ChevronDown size={13} />
        </button>
        <button type="button">
          <MoreHorizontal size={14} />
        </button>
      </div>
      <div className="d-doc-layout">
        <nav className="d-doc-outline">
          <div className="d-nav-label">On this page</div>
          {[
            'Context',
            'Problem',
            'Goals',
            'Personas',
            'Requirements',
            'Acceptance criteria',
            'Out of scope',
            'Definition of done',
          ].map((item, index) => (
            <button
              type="button"
              className={index === 4 ? 'active' : ''}
              key={item}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              {item}
            </button>
          ))}
        </nav>
        <Panel className="d-document">
          <div className="d-document-meta">
            <span>PRODUCT REQUIREMENTS</span>
            <code>SR-0142 · v3</code>
          </div>
          <h1>Persist sessions across API deployments</h1>
          <p className="d-lede">
            Signed-in users must remain authenticated during routine API
            deployments and process restarts.
          </p>
          <h2>
            <span>01</span> Context
          </h2>
          <p>
            The API stores session records in process memory. Each deployment
            replaces every process, invalidating active sessions and returning
            users to sign-in.
          </p>
          <div className="d-evidence">
            <LinkIcon size={14} />
            <span>
              <strong>Evidence</strong> · 31% of support contacts within 20
              minutes of a deploy mention an unexpected sign-out.
            </span>
          </div>
          <h2>
            <span>02</span> Requirements
          </h2>
          <table className="d-doc-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Requirement</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>R-01</td>
                <td>Store session records in the managed Redis service.</td>
                <td>
                  <Badge tone="danger">must</Badge>
                </td>
              </tr>
              <tr>
                <td>R-02</td>
                <td>Preserve the current 12-hour idle timeout.</td>
                <td>
                  <Badge tone="danger">must</Badge>
                </td>
              </tr>
              <tr>
                <td>R-03</td>
                <td>
                  Deploy using a dual-read migration with no forced logout.
                </td>
                <td>
                  <Badge tone="danger">must</Badge>
                </td>
              </tr>
            </tbody>
          </table>
          <h2>
            <span>03</span> Acceptance criteria
          </h2>
          <div className="d-ac-list">
            <div>
              <Badge tone="mint">AC-01</Badge>
              <p>
                Given an active session, when the API is redeployed, then the
                next authenticated request succeeds without a new sign-in.
              </p>
              <button type="button" className="d-comment-pin">
                <MessageSquare size={12} /> 1
              </button>
            </div>
            <div>
              <Badge tone="mint">AC-02</Badge>
              <p>
                Given Redis is temporarily unavailable, the API fails closed and
                emits a session-store health alert.
              </p>
            </div>
          </div>
        </Panel>
        <aside className="d-comment-rail">
          <Panel>
            <SectionHeader title="Review" meta="2 open" />
            <div className="d-review-summary">
              <ProgressRing value={91} />
              <span>
                <strong>Strong specification</strong>
                <small>All critical sections present</small>
              </span>
            </div>
            <div className="d-coverage-bars">
              <div>
                <span>Acceptance criteria</span>
                <b>6 / 6</b>
                <i>
                  <em style={{ width: '100%' }} />
                </i>
              </div>
              <div>
                <span>Test mapping</span>
                <b>16 / 17</b>
                <i>
                  <em style={{ width: '94%' }} />
                </i>
              </div>
              <div>
                <span>Ambiguity checks</span>
                <b>8 / 9</b>
                <i>
                  <em style={{ width: '89%' }} />
                </i>
              </div>
            </div>
          </Panel>
          <div className="d-thread-card">
            <div className="d-thread-head">
              <div className="d-avatar small">KG</div>
              <span>
                <strong>Keith Goff</strong>
                <small>AC-01 · line 42</small>
              </span>
              <MoreHorizontal size={14} />
            </div>
            <p>
              Should this explicitly include a rolling deploy across two
              regions?
            </p>
            <div className="d-thread-reply">
              <div className="d-avatar bot">AI</div>
              <p>Added regional rollout language in v3.</p>
            </div>
            <button type="button">Resolve thread</button>
          </div>
          <div className="d-thread-card">
            <div className="d-thread-head">
              <div className="d-avatar small">RS</div>
              <span>
                <strong>Rina Shah</strong>
                <small>R-03 · line 31</small>
              </span>
            </div>
            <p>Please name the rollback signal for the dual-read window.</p>
            <textarea readOnly value="Reply…" />
          </div>
          <div className="d-doc-decision">
            <Button variant="quiet">Request changes</Button>
            <Button variant="primary" icon={<Check size={14} />}>
              Approve
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

const logLines = [
  ['12:41:06', 'system', 'Run started · implement · backend, web'],
  ['12:41:09', 'agent', 'Reading PRD, TDD, test plan, and repository cards…'],
  ['12:41:31', 'tool', 'git status --short'],
  ['12:41:33', 'result', 'working tree clean'],
  [
    '12:42:18',
    'agent',
    'I found the existing Redis client and session middleware. Implementing the store behind the current interface.',
  ],
  ['12:43:02', 'tool', 'pnpm --filter @veto/backend test session-store'],
  ['12:43:14', 'pass', 'PASS  src/auth/session-store.test.ts  (12 tests)'],
  [
    '12:44:22',
    'agent',
    'Adding dual-read behavior and metrics for fallback reads…',
  ],
  ['12:45:07', 'tool', 'git diff --stat'],
  ['12:45:08', 'result', '6 files changed, 284 insertions(+), 71 deletions(-)'],
  ['12:45:39', 'cursor', 'Writing migration notes'],
];

function RunMonitorScreen() {
  return (
    <div className="d-page d-run-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> Runs
          </span>
        }
        title="Implement · SR-0142"
        description="Persist sessions across API deployments"
        meta={
          <Badge tone="mint" dot>
            running · 04:39
          </Badge>
        }
        actions={
          <>
            <Button variant="quiet" icon={<Pause size={14} />}>
              Pause
            </Button>
            <Button variant="danger" icon={<Square size={13} />}>
              Kill run
            </Button>
          </>
        }
      />
      <div className="d-metric-strip">
        <Metric
          label="Stage"
          value="Implement"
          detail="step 3 of 5"
          tone="blue"
        />
        <Metric label="Tokens" value="28.4k" detail="22.1k in · 6.3k out" />
        <Metric label="Cost" value="$2.18" detail="est. $3.40 total" />
        <Metric
          label="Context"
          value="41%"
          detail="59% remaining"
          tone="mint"
        />
        <Metric
          label="Health"
          value="Active"
          detail="heartbeat 8s ago"
          tone="mint"
        />
      </div>
      <div className="d-run-layout">
        <Panel className="d-terminal-panel">
          <SectionHeader
            title="Live transcript"
            meta="run-impl-142"
            action={
              <>
                <span className="d-live">
                  <i /> Streaming
                </span>
                <button type="button" className="d-terminal-filter">
                  All output <ChevronDown size={12} />
                </button>
              </>
            }
          />
          <div className="d-terminal-body">
            {logLines.map(([time, kind, text]) => (
              <div className={`d-log-line d-log-${kind}`} key={time}>
                <time>{time}</time>
                <span className="d-log-kind">{kind}</span>
                <code>{text}</code>
              </div>
            ))}
          </div>
          <div className="d-terminal-foot">
            <span>
              <Command size={12} /> Auto-scroll on
            </span>
            <span>1,248 lines</span>
            <button type="button">Download log</button>
          </div>
        </Panel>
        <aside className="d-run-rail">
          <Panel>
            <SectionHeader title="Run plan" meta="3 / 5" />
            <div className="d-run-steps">
              <div className="done">
                <i>
                  <Check size={11} />
                </i>
                <span>
                  <strong>Inspect</strong>
                  <small>Repository and prior art</small>
                </span>
                <time>0:52</time>
              </div>
              <div className="done">
                <i>
                  <Check size={11} />
                </i>
                <span>
                  <strong>Implement store</strong>
                  <small>Redis adapter + wiring</small>
                </span>
                <time>2:14</time>
              </div>
              <div className="active">
                <i>
                  <Activity size={11} />
                </i>
                <span>
                  <strong>Migration path</strong>
                  <small>Dual-read and metrics</small>
                </span>
                <time>1:33</time>
              </div>
              <div>
                <i />
                <span>
                  <strong>Verify</strong>
                  <small>Tests, lint, typecheck</small>
                </span>
              </div>
              <div>
                <i />
                <span>
                  <strong>Commit</strong>
                  <small>Artifact collection</small>
                </span>
              </div>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Artifacts" meta="3 updated" />
            <div className="d-artifacts">
              <div>
                <FileCode2 size={14} />
                <span>
                  <strong>session-store.ts</strong>
                  <small>modified · +118 −22</small>
                </span>
              </div>
              <div>
                <FileCode2 size={14} />
                <span>
                  <strong>redis-session-store.ts</strong>
                  <small>new · +94</small>
                </span>
              </div>
              <div>
                <FileText size={14} />
                <span>
                  <strong>DEVIATIONS.md</strong>
                  <small>modified · +1 note</small>
                </span>
              </div>
            </div>
          </Panel>
          <Panel className="d-callout">
            <Activity size={16} />
            <div>
              <strong>Healthy run</strong>
              <p>Output and artifacts changed within the last minute.</p>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function RunsListScreen() {
  return (
    <div className="d-page">
      <PageHeader
        title="Runs"
        description="Active and recent agent work across every workspace."
        meta={
          <Badge tone="mint" dot>
            3 active
          </Badge>
        }
        actions={
          <Button variant="quiet">
            All stages <ChevronDown size={13} />
          </Button>
        }
      />
      <div className="d-metric-strip">
        <Metric
          label="Active now"
          value="3"
          detail="2 implement · 1 survey"
          tone="mint"
        />
        <Metric label="Queued" value="2" detail="next start in ~3m" />
        <Metric label="Completed today" value="18" detail="94% successful" />
        <Metric label="Spend today" value="$18.42" detail="312k tokens" />
      </div>
      <Panel className="d-table-panel">
        <table className="d-data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Ticket / subject</th>
              <th>Stage</th>
              <th>Backend</th>
              <th>Elapsed</th>
              <th>Usage</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'run-impl-142',
                'SR-0142 · Session persistence',
                'implement',
                'devin',
                '04:39',
                '28.4k · $2.18',
                'running',
              ],
              [
                'run-survey-myapp',
                'survey:product:myApp',
                'survey',
                'devin',
                '12:08',
                '62.1k · $4.80',
                'running',
              ],
              [
                'run-review-139',
                'SR-0139 · Webhook delivery',
                'review',
                'aider',
                '02:17',
                '11.6k · $0.91',
                'running',
              ],
              [
                'run-test-140',
                'SR-0140 · Notification fan-out',
                'testplan',
                'devin',
                '08:41',
                '34.9k · $2.68',
                'complete',
              ],
              [
                'run-triage-138',
                'SR-0138 · Persona copy',
                'triage',
                'devin',
                '03:22',
                '13.2k · $1.02',
                'complete',
              ],
            ].map((row) => (
              <tr key={row[0]}>
                <td>
                  <NavLink className="mono" to={demoPath('/runs/run-impl-142')}>
                    {row[0]}
                  </NavLink>
                </td>
                <td>{row[1]}</td>
                <td>
                  <Badge tone="blue">{row[2]}</Badge>
                </td>
                <td>{row[3]}</td>
                <td className="mono">{row[4]}</td>
                <td className="mono">{row[5]}</td>
                <td>
                  <Badge tone={row[6] === 'running' ? 'mint' : 'neutral'} dot>
                    {row[6]}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

const diffRows = [
  [
    '38',
    '38',
    '  export class RedisSessionStore implements SessionStore {',
    'ctx',
  ],
  ['', '39', '+   constructor(private readonly cache: CacheClient) {}', 'add'],
  ['', '40', '+', 'add'],
  [
    '39',
    '41',
    '    async get(sessionId: string): Promise<Session | null> {',
    'ctx',
  ],
  ['40', '', '-     return memory.get(sessionId) ?? null;', 'del'],
  [
    '',
    '42',
    '+     const cached = await this.cache.get(key(sessionId));',
    'add',
  ],
  ['', '43', '+     if (!cached) return null;', 'add'],
  ['', '44', '+     return SessionSchema.parse(JSON.parse(cached));', 'add'],
  ['41', '45', '    }', 'ctx'],
  ['42', '46', '', 'ctx'],
  ['', '47', '+   async put(session: Session): Promise<void> {', 'add'],
  [
    '',
    '48',
    '+     await this.cache.set(key(session.id), JSON.stringify(session), {',
    'add',
  ],
  ['', '49', '+       ttlSeconds: SESSION_IDLE_TTL,', 'add'],
  ['', '50', '+     });', 'add'],
];

function CodeReviewScreen() {
  const [tab, setTab] = useState('Changes');
  return (
    <div className="d-page d-review-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> SR-0142
          </span>
        }
        title="Code review"
        description="Persist sessions across API deployments"
        meta={
          <>
            <Badge tone="mint">review · round 2</Badge>
            <Badge>4 commits</Badge>
          </>
        }
        actions={
          <Button variant="quiet">
            Compare round 1 <ChevronDown size={13} />
          </Button>
        }
      />
      <Panel className="d-review-brief">
        <div className="d-brief-stat">
          <span>Diff</span>
          <strong className="mono d-mint">
            +412 <em>−87</em>
          </strong>
          <small>9 files · backend, web</small>
        </div>
        <div className="d-brief-stat">
          <span>Acceptance criteria</span>
          <strong className="mono">6 / 6 traced</strong>
          <small className="d-inline-checks">
            AC1 ✓ · AC2 ✓ · AC3 ✓ · AC4 ✓
          </small>
        </div>
        <div className="d-brief-stat">
          <span>Tests</span>
          <strong className="mono">16 / 17 pass</strong>
          <small>1 staging-only skip</small>
        </div>
        <div className="d-brief-stat">
          <span>Spec compliance</span>
          <strong>Yes</strong>
          <small>2 documented addenda</small>
        </div>
        <div className="d-brief-stat">
          <span>Risk</span>
          <strong>Medium</strong>
          <small>Session fixation edge</small>
        </div>
        <button type="button" className="d-story-button">
          <GitCommit size={15} />
          <span>Commit story</span>
          <b>4</b>
          <ChevronRight size={14} />
        </button>
      </Panel>
      <Tabs
        items={[
          { label: 'Changes', count: 9 },
          { label: 'Issues', count: 5 },
          { label: 'Test panel', count: 17 },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="d-code-layout">
        <Panel className="d-file-tree">
          <div className="d-file-head">
            <strong>Files changed</strong>
            <span>9</span>
          </div>
          <button type="button" className="d-tree-folder">
            <ChevronDown size={13} />
            <FolderGit2 size={14} /> backend <span>+294 −61</span>
          </button>
          <button type="button" className="active">
            <FileCode2 size={13} />
            <span>redis-session-store.ts</span>
            <em>+94</em>
          </button>
          <button type="button">
            <FileCode2 size={13} />
            <span>session-store.ts</span>
            <em>+118 −22</em>
          </button>
          <button type="button">
            <FileCode2 size={13} />
            <span>auth-plugin.ts</span>
            <em>+42 −19</em>
          </button>
          <button type="button">
            <TestTube2 size={13} />
            <span>session-store.test.ts</span>
            <em>+40</em>
          </button>
          <button type="button" className="d-tree-folder">
            <ChevronRight size={13} />
            <FolderGit2 size={14} /> web <span>+118 −26</span>
          </button>
          <div className="d-file-summary">
            <span>Viewed</span>
            <strong>5 / 9</strong>
            <i>
              <em style={{ width: '56%' }} />
            </i>
          </div>
        </Panel>
        <Panel className="d-diff-panel">
          <div className="d-diff-head">
            <span>
              <FileCode2 size={14} />
              <strong>redis-session-store.ts</strong>
            </span>
            <div>
              <Badge tone="mint">+94</Badge>
              <button type="button">Viewed</button>
              <MoreHorizontal size={14} />
            </div>
          </div>
          <div className="d-diff-hunk">
            @@ -38,5 +38,13 @@ export class RedisSessionStore
          </div>
          <div className="d-diff-code">
            {diffRows.map(([oldLine, newLine, code, kind]) => (
              <div
                className={`d-diff-row ${kind}`}
                key={`${oldLine}:${newLine}:${code}`}
              >
                <span>{oldLine}</span>
                <span>{newLine}</span>
                <code>{code}</code>
                {newLine === '44' && (
                  <button type="button" className="d-line-note">
                    <AlertTriangle size={11} /> F-8F3A
                  </button>
                )}
              </div>
            ))}
          </div>
        </Panel>
        <aside className="d-findings-rail">
          <SectionHeader
            title="Findings"
            meta="5 open"
            action={
              <button type="button">
                <Search size={13} />
              </button>
            }
          />
          <div className="d-finding-card blocker">
            <div className="d-finding-top">
              <Badge tone="danger">blocker</Badge>
              <Badge>code-bug</Badge>
              <code>F-8F3A</code>
            </div>
            <strong>
              Malformed cache entries can fail every authenticated request.
            </strong>
            <p>
              <code>SessionSchema.parse</code> throws without eviction or
              fallback. A single corrupt value creates a persistent outage for
              that session.
            </p>
            <button type="button" className="d-location-link">
              redis-session-store.ts:44 <ArrowRight size={12} />
            </button>
            <div className="d-confidence">
              <span>confidence 0.94</span>
              <span>rounds 1, 2</span>
            </div>
            <div className="d-finding-actions">
              <button type="button">Send to fix</button>
              <button type="button">Dismiss</button>
              <button type="button">Wontfix</button>
            </div>
          </div>
          <div className="d-finding-card major">
            <div className="d-finding-top">
              <Badge tone="orange">major</Badge>
              <Badge tone="purple">spec-bug</Badge>
              <code>F-4C21</code>
            </div>
            <strong>Rollback alert threshold is unspecified.</strong>
            <p>
              The TDD names the metric but not the value that stops dual-read.
            </p>
            <button type="button" className="d-location-link">
              DEVIATIONS.md:18 <ArrowRight size={12} />
            </button>
            <div className="d-finding-actions">
              <button type="button">Send to fix</button>
              <button type="button">Reply</button>
            </div>
          </div>
        </aside>
      </div>
      <div className="d-decision-bar">
        <span>
          <strong>5 open findings</strong> · 1 blocker · 2 major
        </span>
        <span className="d-flex-spacer" />
        <Button variant="quiet">Send back</Button>
        <Button variant="primary" icon={<GitMerge size={14} />} disabled>
          Approve → PR
        </Button>
      </div>
    </div>
  );
}

function PrPanelScreen() {
  return (
    <div className="d-page">
      <PageHeader
        eyebrow={
          <span className="d-back">
            <ArrowLeft size={13} /> SR-0142
          </span>
        }
        title="Pull requests"
        description="Two repositories move as one product change. Veto will shepherd both through merge."
        meta={<Badge tone="blue">shepherding</Badge>}
        actions={
          <>
            <Button variant="quiet" icon={<RefreshCw size={14} />}>
              Check now
            </Button>
            <Button variant="primary" icon={<GitMerge size={14} />}>
              Merge all
            </Button>
          </>
        }
      />
      <Panel className="d-pr-summary">
        <div>
          <CheckCircle2 size={21} />
          <span>
            <strong>Ready to merge</strong>
            <small>
              All required checks and reviews are green across 2 repositories.
            </small>
          </span>
        </div>
        <div className="d-pr-summary-stats">
          <span>
            <b>12 / 12</b> checks
          </span>
          <span>
            <b>3</b> approvals
          </span>
          <span>
            <b>0</b> conflicts
          </span>
          <span>
            <b>2</b> PRs
          </span>
        </div>
      </Panel>
      <div className="d-pr-grid">
        {[
          {
            repo: 'backend',
            number: '#842',
            title: 'Persist sessions in managed Redis',
            branch: 'ticket/SR-0142',
            changes: '+294 −61 · 6 files',
            approvals: '2 approvals',
            checks: [
              'unit / node-22',
              'integration / redis',
              'lint + typecheck',
              'gitleaks',
            ],
          },
          {
            repo: 'web',
            number: '#391',
            title: 'Handle session refresh during rolling deploys',
            branch: 'ticket/SR-0142',
            changes: '+118 −26 · 3 files',
            approvals: '1 approval',
            checks: [
              'unit / node-22',
              'e2e / auth-flow',
              'lint + typecheck',
              'bundle budget',
            ],
          },
        ].map((pr) => (
          <Panel className="d-pr-card" key={pr.repo}>
            <div className="d-pr-head">
              <div className="d-repo-icon">
                <Github size={18} />
              </div>
              <span>
                <strong>
                  {pr.repo} <em>{pr.number}</em>
                </strong>
                <small>{pr.title}</small>
              </span>
              <Badge tone="mint" dot>
                open
              </Badge>
            </div>
            <div className="d-pr-meta">
              <code>
                <GitBranch size={12} /> {pr.branch}
              </code>
              <span>{pr.changes}</span>
              <span>
                <Users size={13} /> {pr.approvals}
              </span>
            </div>
            <div className="d-checks">
              <div className="d-checks-title">
                <span>Required checks</span>
                <strong>
                  {pr.checks.length} / {pr.checks.length}
                </strong>
              </div>
              {pr.checks.map((check) => (
                <div key={check}>
                  <CheckCircle2 size={14} />
                  <span>{check}</span>
                  <code>{check.includes('e2e') ? '3m 18s' : '1m 42s'}</code>
                </div>
              ))}
            </div>
            <div className="d-pr-foot">
              <span>Updated 2 min ago</span>
              <button type="button">
                Open on GitHub <ArrowRight size={13} />
              </button>
            </div>
          </Panel>
        ))}
      </div>
      <div className="d-pr-lower">
        <Panel>
          <SectionHeader title="Merge order" meta="squash" />
          <div className="d-merge-order">
            <span className="d-order-num">1</span>
            <FolderGit2 size={15} />
            <strong>backend</strong>
            <span>Deploys session compatibility first</span>
            <ArrowRight size={14} />
            <span className="d-order-num">2</span>
            <FolderGit2 size={15} />
            <strong>web</strong>
          </div>
          <div className="d-callout-inline">
            <ShieldCheck size={15} />
            <span>
              Veto will pause if either branch moves or a required check
              regresses.
            </span>
          </div>
        </Panel>
        <Panel>
          <SectionHeader title="Recent shepherd activity" />
          <div className="d-activity-feed compact">
            <div>
              <i className="mint">
                <Check size={11} />
              </i>
              <span>
                <strong>CI recovered</strong>
                <small>backend / integration · 18m ago</small>
              </span>
            </div>
            <div>
              <i className="blue">
                <MessageSquare size={11} />
              </i>
              <span>
                <strong>Review comment resolved</strong>
                <small>web #391 · 31m ago</small>
              </span>
            </div>
            <div>
              <i className="purple">
                <GitCommit size={11} />
              </i>
              <span>
                <strong>Rebase completed</strong>
                <small>both repositories · 46m ago</small>
              </span>
            </div>
          </div>
        </Panel>
      </div>
      <div className="d-decision-bar">
        <span>
          <strong>Squash merge</strong> · 2 PRs · rollback plan verified
        </span>
        <span className="d-flex-spacer" />
        <Button variant="quiet">Change strategy</Button>
        <Button variant="primary" icon={<GitMerge size={14} />}>
          Merge 2 pull requests
        </Button>
      </div>
    </div>
  );
}

const failureRows = [
  [
    'SR-0136',
    'Billing export loses timezone',
    'implement',
    'timeout after 7,200s',
    'team-a',
    'P1',
    '12m',
    'failed',
  ],
  [
    'WEB-77',
    'SSO provider selection',
    'triage',
    'agent requested human escalation',
    'eng-portal',
    'P0',
    '1h',
    'escalated',
  ],
  [
    'SR-0131',
    'Audit log retention',
    'doc-repair',
    'TDD frontmatter is malformed',
    'team-a',
    'P2',
    '3h',
    'repair',
  ],
  [
    'WEB-63',
    'Table keyboard navigation',
    'review',
    'operator aborted run',
    'eng-portal',
    'P2',
    '1d',
    'aborted',
  ],
];

function FailuresScreen() {
  const [selected, setSelected] = useState(0);
  return (
    <div className="d-page">
      <PageHeader
        title="Failures & escalations"
        description="Recover work that cannot progress without intervention."
        meta={
          <Badge tone="danger" dot>
            4 need attention
          </Badge>
        }
        actions={
          <Button variant="quiet" icon={<RefreshCw size={14} />}>
            Refresh
          </Button>
        }
      />
      <div className="d-toolbar">
        <button type="button">
          All failure types <ChevronDown size={13} />
        </button>
        <button type="button">
          All workspaces <ChevronDown size={13} />
        </button>
        <button type="button">
          Newest first <ChevronDown size={13} />
        </button>
        <span className="d-flex-spacer" />
        <div className="d-search-small">
          <Search size={13} /> Search queue
        </div>
      </div>
      <div className="d-queue-layout">
        <Panel className="d-queue-list">
          <div className="d-queue-head">
            <span>Subject</span>
            <span>Stage / reason</span>
            <span>Workspace</span>
            <span>Age</span>
          </div>
          {failureRows.map((row, index) => (
            <button
              type="button"
              className={selected === index ? 'selected' : ''}
              key={row[0]}
              onClick={() => setSelected(index)}
            >
              <span className={`d-failure-icon ${row[7]}`}>
                <AlertTriangle size={14} />
              </span>
              <span>
                <strong className="mono">{row[0]}</strong>
                <small>{row[1]}</small>
              </span>
              <span>
                <Badge
                  tone={
                    row[7] === 'repair'
                      ? 'warning'
                      : row[7] === 'escalated'
                        ? 'orange'
                        : 'danger'
                  }
                >
                  {row[2]}
                </Badge>
                <small>{row[3]}</small>
              </span>
              <span>
                {row[4]}
                <small>{row[5]}</small>
              </span>
              <time>{row[6]}</time>
              <ChevronRight size={14} />
            </button>
          ))}
        </Panel>
        <aside className="d-failure-detail">
          <Panel>
            <div className="d-detail-eyebrow">
              <Badge tone="danger">failed</Badge>
              <code>run-impl-136</code>
            </div>
            <h2>Billing export loses timezone</h2>
            <p className="d-muted">
              The implementation run exceeded the configured 7,200 second
              timeout while retrying an integration test.
            </p>
            <dl className="d-detail-grid">
              <div>
                <dt>Stage</dt>
                <dd>implement</dd>
              </div>
              <div>
                <dt>Backend</dt>
                <dd>devin</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>2 / 3</dd>
              </div>
              <div>
                <dt>Spent</dt>
                <dd>$6.14 · 82k</dd>
              </div>
            </dl>
            <div className="d-log-excerpt">
              <div>LAST OUTPUT</div>
              <code>FAIL billing-export.integration.test.ts</code>
              <code className="bad">Timeout waiting for localstack object</code>
              <code>47 passed · 1 failed · 6m 01s</code>
            </div>
            <div className="d-detail-actions">
              <Button variant="primary" icon={<RotateCcw size={14} />}>
                Retry stage
              </Button>
              <Button variant="quiet">Edit ticket & retry</Button>
              <Button variant="danger">Won’t do</Button>
            </div>
          </Panel>
          <Panel className="d-callout d-callout-warning">
            <Sparkles size={16} />
            <div>
              <strong>Suggested recovery</strong>
              <p>
                The test appears environment-bound. Retry once with the verified
                localstack repo card.
              </p>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

const ledgerEvents = [
  [
    '12:45:39',
    'run_output',
    'Run wrote migration notes',
    'veto-bot',
    'run-impl-142',
    'mint',
  ],
  [
    '12:41:06',
    'run_started',
    'Implementation run started',
    'conductor',
    'run-impl-142',
    'blue',
  ],
  [
    '11:58:44',
    'gate_cleared',
    'Test plan approved',
    'Keith Goff',
    'SR-0142',
    'purple',
  ],
  [
    '11:42:18',
    'doc_approved',
    'TDD.md v2 approved',
    'Keith Goff',
    'SR-0142',
    'mint',
  ],
  [
    '11:18:03',
    'answer_recorded',
    'Cache backend: managed Redis',
    'Keith Goff',
    'SR-0142',
    'purple',
  ],
  [
    '10:59:27',
    'run_completed',
    'Triage completed successfully',
    'veto-bot',
    'run-triage-142',
    'mint',
  ],
];

function LedgerScreen() {
  return (
    <div className="d-page">
      <PageHeader
        title="Ledger"
        description="An immutable account of human decisions, agent work, and cost."
        meta={
          <Badge tone="mint">
            <ShieldCheck size={11} /> verified
          </Badge>
        }
        actions={<Button variant="quiet">Export JSONL</Button>}
      />
      <div className="d-toolbar">
        <button type="button">
          All workspaces <ChevronDown size={13} />
        </button>
        <button type="button">
          All event types <ChevronDown size={13} />
        </button>
        <button type="button">
          Last 7 days <ChevronDown size={13} />
        </button>
        <div className="d-search-small">
          <Search size={13} /> Ticket, actor, or hash
        </div>
        <span className="d-flex-spacer" />
        <span>1,284 events</span>
      </div>
      <div className="d-ledger-layout">
        <Panel className="d-ledger-stream">
          <div className="d-ledger-date">
            <span>Today · October 3</span>
            <i />
          </div>
          {ledgerEvents.map((event, index) => (
            <button
              type="button"
              className={index === 2 ? 'selected' : ''}
              key={`${event[0]}${event[1]}`}
            >
              <time>{event[0]}</time>
              <span className={`d-event-node ${event[5]}`}>
                <i />
              </span>
              <span className="d-event-copy">
                <strong>{event[2]}</strong>
                <small>
                  <Badge tone={event[5] as Tone}>{event[1]}</Badge> by{' '}
                  {event[3]}
                </small>
              </span>
              <code>{event[4]}</code>
              <ChevronRight size={14} />
            </button>
          ))}
        </Panel>
        <aside className="d-event-detail">
          <Panel>
            <div className="d-detail-eyebrow">
              <Badge tone="purple">gate_cleared</Badge>
              <code>evt_08fb36d2</code>
            </div>
            <h2>Test plan approved</h2>
            <dl className="d-detail-grid">
              <div>
                <dt>Actor</dt>
                <dd>Keith Goff</dd>
              </div>
              <div>
                <dt>Subject</dt>
                <dd className="mono">SR-0142</dd>
              </div>
              <div>
                <dt>Workspace</dt>
                <dd>team-a</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>11:58:44</dd>
              </div>
            </dl>
            <SectionHeader
              title="Event payload"
              action={<button type="button">Copy</button>}
            />
            <pre className="d-json">{`{
  "gate": "test-review",
  "document": "TEST.md",
  "version": 2,
  "spec_score": 91,
  "human_minutes": 7
}`}</pre>
            <div className="d-hash">
              <ShieldCheck size={14} />
              <span>
                <strong>Commit-backed evidence</strong>
                <code>8e14c6f…a922</code>
              </span>
              <button type="button">Inspect</button>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Usage attached" />
            <div className="d-usage-row">
              <span>Tokens in</span>
              <code>14,832</code>
            </div>
            <div className="d-usage-row">
              <span>Tokens out</span>
              <code>3,204</code>
            </div>
            <div className="d-usage-row">
              <span>Cost</span>
              <code>$1.38</code>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function BarChart() {
  const data: Array<[string, number]> = [
    ['W1', 42],
    ['W2', 51],
    ['W3', 38],
    ['W4', 66],
    ['W5', 74],
    ['W6', 58],
    ['W7', 82],
    ['W8', 77],
    ['W9', 91],
    ['W10', 86],
    ['W11', 94],
    ['W12', 88],
  ];
  return (
    <div className="d-bar-chart">
      {data.map(([week, value]) => (
        <div key={week}>
          <i style={{ height: `${value}%` }} />
          <span>{Number(week.slice(1)) % 2 === 1 ? week : ''}</span>
        </div>
      ))}
    </div>
  );
}

function MetricsScreen() {
  return (
    <div className="d-page">
      <PageHeader
        title="Metrics"
        description="Throughput is useful. Evidence quality is the product."
        meta={<Badge>Last 30 days</Badge>}
        actions={
          <>
            <Button variant="quiet">
              All workspaces <ChevronDown size={13} />
            </Button>
            <Button variant="quiet">Export CSV</Button>
          </>
        }
      />
      <div className="d-metric-strip d-six-metrics">
        <Metric
          label="Tickets → PR"
          value="68%"
          detail="↑ 9 pts vs prior"
          tone="mint"
        />
        <Metric label="Median cycle" value="1.8d" detail="↓ 4.2 hours" />
        <Metric label="Human time" value="22m" detail="per completed ticket" />
        <Metric
          label="Spec score"
          value="84"
          detail="↑ 6 average"
          tone="mint"
        />
        <Metric
          label="Deviation rate"
          value="7.4%"
          detail="↓ 2.1 pts"
          tone="mint"
        />
        <Metric
          label="Spend / ticket"
          value="$8.42"
          detail="418k total tokens"
        />
      </div>
      <div className="d-metrics-grid">
        <Panel className="d-chart-card d-span-2">
          <SectionHeader
            title="Ticket throughput"
            meta="created vs merged"
            action={<Badge tone="mint">+18% trend</Badge>}
          />
          <div className="d-chart-legend">
            <span>
              <i className="mint" />
              Merged
            </span>
            <span>
              <i className="muted" />
              Created
            </span>
          </div>
          <BarChart />
        </Panel>
        <Panel className="d-chart-card">
          <SectionHeader title="Tickets → PR funnel" />
          <div className="d-funnel">
            <div>
              <span>Created</span>
              <i style={{ width: '100%' }} />
              <b>48</b>
            </div>
            <div>
              <span>Spec approved</span>
              <i style={{ width: '85%' }} />
              <b>41</b>
            </div>
            <div>
              <span>Implemented</span>
              <i style={{ width: '75%' }} />
              <b>36</b>
            </div>
            <div>
              <span>Review passed</span>
              <i style={{ width: '71%' }} />
              <b>34</b>
            </div>
            <div>
              <span>Merged</span>
              <i style={{ width: '67%' }} />
              <b>32</b>
            </div>
          </div>
        </Panel>
        <Panel className="d-chart-card">
          <SectionHeader title="Spec quality" meta="weekly average" />
          <div className="d-line-chart">
            <svg
              viewBox="0 0 320 120"
              preserveAspectRatio="none"
              role="img"
              aria-label="Spec quality trend"
            >
              <title>Spec quality trend from 62 to 84</title>
              <line x1="0" y1="95" x2="320" y2="95" />
              <line x1="0" y1="50" x2="320" y2="50" />
              <polyline points="0,92 40,84 80,88 120,67 160,72 200,47 240,42 280,27 320,22" />
              <circle cx="320" cy="22" r="4" />
            </svg>
            <div>
              <span>62</span>
              <span>84</span>
            </div>
          </div>
          <div className="d-chart-note">
            <ProgressRing value={84} />
            <span>
              <strong>+22 points</strong>
              <small>since the pilot began</small>
            </span>
          </div>
        </Panel>
        <Panel className="d-chart-card">
          <SectionHeader title="Failure stages" meta="11 total" />
          <div className="d-horizontal-bars">
            {[
              ['implement', 5, 45],
              ['review', 3, 27],
              ['triage', 2, 18],
              ['shepherd', 1, 9],
            ].map(([name, count, width]) => (
              <div key={name}>
                <span>{name}</span>
                <i>
                  <em style={{ width: `${width}%` }} />
                </i>
                <b>{count}</b>
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="d-chart-card">
          <SectionHeader title="Human attention" meta="7.4h total" />
          <div className="d-attention-list">
            <div>
              <span>Spec decisions</span>
              <b>3.1h</b>
              <i style={{ width: '76%' }} />
            </div>
            <div>
              <span>Code review</span>
              <b>2.4h</b>
              <i style={{ width: '59%' }} />
            </div>
            <div>
              <span>Recovery</span>
              <b>1.2h</b>
              <i style={{ width: '29%' }} />
            </div>
            <div>
              <span>PR shepherd</span>
              <b>0.7h</b>
              <i style={{ width: '17%' }} />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function WorkspacesScreen() {
  return (
    <div className="d-page">
      <PageHeader
        title="Workspaces"
        description="Ticket repositories are the durable boundary for work, decisions, and audit history."
        meta={
          <Badge tone="mint" dot>
            2 connected
          </Badge>
        }
        actions={
          <Button variant="primary" icon={<Plus size={14} />}>
            Add workspace
          </Button>
        }
      />
      <div className="d-workspace-grid">
        {[
          {
            name: 'team-a',
            path: 'github.com/acme/team-a-sprint-tickets',
            branch: 'main',
            gates: 6,
            queue: 2,
            sync: '34s ago',
            status: 'healthy',
            color: 'mint' as Tone,
          },
          {
            name: 'eng-portal',
            path: 'github.com/acme/portal-sprint-tickets',
            branch: 'main',
            gates: 3,
            queue: 1,
            sync: '4m ago',
            status: 'healthy',
            color: 'mint' as Tone,
          },
        ].map((workspace) => (
          <Panel className="d-workspace-card" key={workspace.name}>
            <div className="d-workspace-card-head">
              <div className="d-workspace-mark">
                <FolderGit2 size={19} />
              </div>
              <span>
                <strong>{workspace.name}</strong>
                <small>{workspace.path}</small>
              </span>
              <Badge tone={workspace.color} dot>
                {workspace.status}
              </Badge>
              <IconButton label="Workspace menu">
                <MoreHorizontal size={15} />
              </IconButton>
            </div>
            <div className="d-workspace-metrics">
              <div>
                <span>Open gates</span>
                <strong>{workspace.gates}</strong>
              </div>
              <div>
                <span>Queued runs</span>
                <strong>{workspace.queue}</strong>
              </div>
              <div>
                <span>Tickets</span>
                <strong>{workspace.name === 'team-a' ? 42 : 18}</strong>
              </div>
              <div>
                <span>Last sync</span>
                <strong>{workspace.sync}</strong>
              </div>
            </div>
            <div className="d-workspace-details">
              <span>
                <GitBranch size={13} /> {workspace.branch}
              </span>
              <span>
                <Database size={13} /> projection current
              </span>
              <span>
                <ShieldCheck size={13} /> clean history
              </span>
            </div>
            <div className="d-workspace-actions">
              <Button variant="quiet" icon={<RefreshCw size={13} />}>
                Sync now
              </Button>
              <Button variant="quiet">Open tickets</Button>
              <span className="d-flex-spacer" />
              <span className="d-live">
                <i /> Watching
              </span>
            </div>
          </Panel>
        ))}
        <button type="button" className="d-add-workspace">
          <span>
            <Plus size={22} />
          </span>
          <strong>Add a ticket repository</strong>
          <small>Clone an existing ledger or initialize a new workspace.</small>
        </button>
      </div>
      <Panel className="d-workspace-help">
        <div>
          <Box size={18} />
          <span>
            <strong>How workspaces behave</strong>
            <small>
              Each workspace maps to one ticket Git repository. Git holds the
              auditable product record; the local database coordinates live
              work.
            </small>
          </span>
        </div>
        <button type="button">
          Read architecture notes <ArrowRight size={13} />
        </button>
      </Panel>
    </div>
  );
}

function KnowledgeBaseScreen() {
  const [section, setSection] = useState('Architecture');
  return (
    <div className="d-page d-kb-page">
      <PageHeader
        title="Knowledge base"
        description="Human-correctable product dossiers grounded in code, docs, screenshots, and observed flows."
        meta={
          <Badge tone="warning" dot>
            4 gaps
          </Badge>
        }
        actions={
          <>
            <Button variant="quiet" icon={<Search size={14} />}>
              Search
            </Button>
            <Button variant="primary" icon={<RefreshCw size={14} />}>
              Sync now
            </Button>
          </>
        }
      />
      <div className="d-kb-layout">
        <nav className="d-kb-tree">
          <div className="d-tree-search">
            <Search size={13} /> Search dossier
          </div>
          <div className="d-nav-label">Products</div>
          <button type="button" className="d-kb-product">
            <ChevronDown size={13} />
            <Layers3 size={14} />
            <strong>myApp</strong>
            <Badge tone="mint">v4</Badge>
          </button>
          <button type="button" className="d-kb-repo active">
            <FolderGit2 size={13} />
            backend
            <span className="d-stale-dot" />
          </button>
          <button type="button" className="d-kb-repo">
            <FolderGit2 size={13} />
            frontend
          </button>
          <div className="d-nav-label d-section-label">Dossier sections</div>
          {[
            'Architecture',
            'Domain model',
            'Workflows',
            'Personas',
            'Documentation',
            'UI map',
            'Glossary',
            'Landmines',
            'Gap report',
          ].map((item) => (
            <button
              type="button"
              className={`d-kb-section ${section === item ? 'active' : ''}`}
              key={item}
              onClick={() => setSection(item)}
            >
              <span>{item}</span>
              {item === 'Architecture' && <i className="d-stale-dot" />}
              {item === 'Gap report' && <Badge tone="warning">4</Badge>}
            </button>
          ))}
          <div className="d-nav-label d-section-label">Other repositories</div>
          <button type="button" className="d-kb-product">
            <ChevronRight size={13} />
            <FolderGit2 size={14} />
            worker
          </button>
        </nav>
        <Panel className="d-kb-document">
          <div className="d-kb-doc-head">
            <div>
              <div className="d-eyebrow">BACKEND · DOSSIER V4</div>
              <h2>Architecture</h2>
              <p>Surveyed 3 days ago · code, docs, screenshots, crawl</p>
            </div>
            <div>
              <Badge tone="warning" dot>
                stale in 1 area
              </Badge>
              <IconButton label="Edit dossier">
                <FileText size={15} />
              </IconButton>
              <IconButton label="More actions">
                <MoreHorizontal size={15} />
              </IconButton>
            </div>
          </div>
          <div className="d-kb-section-body">
            <h3>
              <span>01</span> System map
            </h3>
            <p>
              The backend is a modular Node service organized around HTTP
              boundaries, domain services, and adapters. PostgreSQL is the
              system of record; Redis provides ephemeral shared state.
            </p>
            <div className="d-architecture-map">
              <div>
                <span>CLIENTS</span>
                <strong>Web · CLI · integrations</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>API LAYER</span>
                <strong>Fastify routes + auth</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>DOMAIN</span>
                <strong>Tickets · runs · sessions</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>DATA</span>
                <strong>Postgres · Redis · Git</strong>
              </div>
            </div>
            <h3>
              <span>02</span> Personas
            </h3>
            <table className="d-doc-table d-kb-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role in product</th>
                  <th>Source</th>
                  <th>Evidence</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Operator</td>
                  <td>Clears gates and reviews evidence</td>
                  <td>
                    <Badge tone="mint">confirmed</Badge>
                  </td>
                  <td>UI flows, event actors</td>
                  <td>
                    <button type="button">Edit</button>
                  </td>
                </tr>
                <tr>
                  <td>On-call engineer</td>
                  <td>Recovers failed runs and deployments</td>
                  <td>
                    <Badge tone="warning">inferred</Badge>
                  </td>
                  <td>Runbooks, alerts</td>
                  <td>
                    <button type="button">Confirm</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <h3>
              <span>03</span> Gap report
            </h3>
            <div className="d-gap-list">
              <div>
                <span className="d-gap-severity high">H</span>
                <span>
                  <strong>Password reset recovery is undocumented</strong>
                  <small>
                    undocumented-workflow · evidence: auth routes + support
                    runbook
                  </small>
                </span>
                <Badge tone="warning">high</Badge>
                <button type="button">File ticket</button>
              </div>
              <div>
                <span className="d-gap-severity medium">M</span>
                <span>
                  <strong>
                    Session cache behavior contradicts the operations manual
                  </strong>
                  <small>doc-vs-code-contradiction · 2 sources</small>
                </span>
                <Badge>medium</Badge>
                <button type="button">Review</button>
              </div>
            </div>
          </div>
        </Panel>
        <aside className="d-kb-rail">
          <Panel>
            <SectionHeader title="Survey status" />
            <div className="d-survey-age">
              <RefreshCw size={18} />
              <span>
                <strong>3 days ago</strong>
                <small>completed in 18m 42s</small>
              </span>
            </div>
            <div className="d-source-list">
              <span>
                <Check size={12} /> Code
              </span>
              <span>
                <Check size={12} /> Docs
              </span>
              <span>
                <Check size={12} /> Screenshots
              </span>
              <span>
                <Check size={12} /> App crawl
              </span>
            </div>
            <Button variant="primary" icon={<RefreshCw size={13} />}>
              Sync now
            </Button>
            <div className="d-schedule-row">
              <span>Schedule</span>
              <button type="button">
                Weekly <ChevronDown size={12} />
              </button>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Linked entities" meta="12" />
            <div className="d-entity-list">
              <button type="button">
                <span className="d-entity-icon">
                  <Database size={13} />
                </span>
                <span>
                  <strong>Session</strong>
                  <small>domain entity · 8 links</small>
                </span>
              </button>
              <button type="button">
                <span className="d-entity-icon">
                  <Code2 size={13} />
                </span>
                <span>
                  <strong>CachePolicy</strong>
                  <small>interface · 5 links</small>
                </span>
              </button>
              <button type="button">
                <span className="d-entity-icon">
                  <Users size={13} />
                </span>
                <span>
                  <strong>Operator</strong>
                  <small>persona · confirmed</small>
                </span>
              </button>
            </div>
          </Panel>
          <Panel className="d-callout d-callout-warning">
            <AlertTriangle size={16} />
            <div>
              <strong>One section is stale</strong>
              <p>
                Session-store files changed after the last architecture survey.
              </p>
              <button type="button">See changed sources</button>
            </div>
          </Panel>
          <Panel>
            <SectionHeader title="Version history" />
            <div className="d-version-row">
              <span>v4 · current</span>
              <small>Oct 1 · survey</small>
            </div>
            <div className="d-version-row">
              <span>v3</span>
              <small>Sep 18 · Keith</small>
            </div>
            <div className="d-version-row">
              <span>v2</span>
              <small>Sep 10 · survey</small>
            </div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

export default function DemoApp() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomeScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/new" element={<CreateImportScreen />} />
        <Route path="/tickets/:ws/:id" element={<TicketFocusScreen />} />
        <Route
          path="/tickets/:ws/:id/legacy"
          element={<TicketDetailScreen />}
        />
        <Route path="/tickets/:ws/:id/wizard" element={<WizardScreen />} />
        <Route
          path="/tickets/:ws/:id/docs/:name"
          element={<DocReviewScreen />}
        />
        <Route path="/tickets/:ws/:id/review" element={<CodeReviewScreen />} />
        <Route path="/tickets/:ws/:id/pr" element={<PrPanelScreen />} />
        <Route path="/tickets/:ws/:id/ledger" element={<LedgerScreen />} />
        <Route path="/runs" element={<RunsListScreen />} />
        <Route path="/runs/:id" element={<RunMonitorScreen />} />
        <Route path="/queue" element={<FailuresScreen />} />
        <Route path="/ledger" element={<LedgerScreen />} />
        <Route path="/metrics" element={<MetricsScreen />} />
        <Route path="/workspaces" element={<WorkspacesScreen />} />
        <Route path="/kb" element={<KnowledgeBaseScreen />} />
        <Route path="*" element={<HomeScreen />} />
      </Routes>
    </Shell>
  );
}
