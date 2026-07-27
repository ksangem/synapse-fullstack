/*
 * Help Center content registry — the single source of truth for the in-app
 * documentation. The Help drawer groups these by `category`; the modal reader,
 * the "Ask" search, and the standalone /help/:slug route all look them up by `slug`.
 *
 * Each article body is an array of blocks rendered by HelpDocView (no markdown
 * dependency). Supported block types:
 *   { type: 'p',       text }
 *   { type: 'h2',      text }
 *   { type: 'ul',      items: [] }
 *   { type: 'steps',   items: [] }                       // ordered / numbered
 *   { type: 'code',    code, lang? }
 *   { type: 'callout', variant: 'tip'|'warn'|'note', text }
 *   { type: 'table',   headers: [], rows: [[]] }
 *   { type: 'link',    to, text }                        // internal app route
 *   { type: 'doclink', slug, text }                      // cross-link to another help doc
 */

export const helpArticles = [
  // ─────────────────────────────────────────── Getting Started
  {
    slug: 'what-is-synapse',
    category: 'Getting Started',
    title: 'What is Synapse?',
    desc: 'The one-paragraph tour of the platform and what it does for you',
    keywords: 'overview intro about platform jira sharepoint hub integration',
    body: [
      { type: 'p', text: 'Synapse is an integration platform that moves data between the systems your team already uses. Its core job is keeping records in sync — for example pulling issues out of Jira, reshaping them, and pushing them into a SharePoint list, or copying a SharePoint list into a relational database.' },
      { type: 'p', text: 'Every transfer flows through a reliable message bus, so nothing is lost if a destination is briefly unavailable — failed records are parked and can be replayed. You design integrations visually, run them on demand or on a schedule, and watch their health from a single dashboard.' },
      { type: 'h2', text: 'The three building blocks' },
      { type: 'ul', items: [
        'Connectors — reusable templates that teach Synapse how to talk to a system (Jira, SharePoint, a database, a file share).',
        'Connections — a live, configured instance of a connector wired to a source and a destination.',
        'Entities — the canonical shape of your data (an "Issue", a "Contact") that mapping targets.',
      ] },
      { type: 'doclink', slug: 'connectors-connections-entities', text: 'Read more: Connectors vs Connections vs Entities' },
      { type: 'callout', variant: 'tip', text: 'New here? The fastest way to see Synapse work is to build one integration end to end with the Connection Wizard.' },
      { type: 'doclink', slug: 'your-first-integration', text: 'Start: Your first integration' },
    ],
  },
  {
    slug: 'your-first-integration',
    category: 'Getting Started',
    title: 'Your First Integration',
    desc: 'Build a Jira → SharePoint sync end to end with the Connection Wizard',
    keywords: 'wizard first setup new create getting started walkthrough tutorial',
    body: [
      { type: 'p', text: 'The Connection Wizard walks you through building an integration in six guided steps. You never touch code — each step validates before it lets you continue.' },
      { type: 'steps', items: [
        'Select systems — choose a source (e.g. Jira) and a destination (e.g. SharePoint).',
        'Credentials — pick saved credentials from the Vault or enter new ones, then test the connection.',
        'Entities — choose which records to move (issues, worklogs, sprints…).',
        'Mapping — line up source fields with destination columns; add presets, joins, or expressions.',
        'Fetch & review — pull a sample and confirm the data looks right before anything is written.',
        'Push & sync — deliver the records and, optionally, set a recurring schedule.',
      ] },
      { type: 'link', to: '/wizard', text: 'Open the Connection Wizard' },
      { type: 'callout', variant: 'note', text: 'Nothing is written to your destination until the Push & sync step — Fetch & review is always safe to run.' },
      { type: 'doclink', slug: 'wizard-overview', text: 'Deep dive: the six wizard steps' },
    ],
  },
  {
    slug: 'understanding-the-dashboard',
    category: 'Getting Started',
    title: 'Understanding the Health Dashboard',
    desc: 'Read the platform-wide health, throughput, and status at a glance',
    keywords: 'dashboard home health status overview metrics landing',
    body: [
      { type: 'p', text: 'The Health Dashboard is your landing page. It summarizes the state of every integration so you can spot trouble without opening each one.' },
      { type: 'ul', items: [
        'A live status badge tells you whether the platform is healthy, degraded, or has failures.',
        'Throughput and message charts show how much data has moved recently.',
        'Recent activity and failures link straight to the Message Monitor for detail.',
      ] },
      { type: 'link', to: '/dashboard', text: 'Open the Health Dashboard' },
      { type: 'doclink', slug: 'message-monitor', text: 'Related: the Message Monitor' },
    ],
  },
  {
    slug: 'navigating-synapse',
    category: 'Getting Started',
    title: 'Navigating the App & Global Search',
    desc: 'Find your way around the sidebar, topbar, and universal search',
    keywords: 'navigation sidebar topbar search menu find shortcuts move around',
    body: [
      { type: 'p', text: 'The left sidebar groups pages into Operations, Design, and Platform. What you see depends on your role. The topbar holds the global search, theme toggle, notifications, help, and your account menu.' },
      { type: 'h2', text: 'Global search' },
      { type: 'p', text: 'The search box in the topbar jumps to any page, connector, connection, or entity. Start typing and press Enter to open the first match.' },
      { type: 'doclink', slug: 'roles-at-a-glance', text: 'Why some menu items are hidden: Roles at a glance' },
      { type: 'doclink', slug: 'keyboard-and-search', text: 'Reference: keyboard shortcuts & search' },
    ],
  },
  {
    slug: 'roles-at-a-glance',
    category: 'Getting Started',
    title: 'Roles at a Glance',
    desc: 'What admins, designers, and operators can each do',
    keywords: 'roles rbac permissions admin designer operator access who can',
    body: [
      { type: 'p', text: 'Synapse uses role-based access control. Your role decides which pages and actions are available to you.' },
      { type: 'table', headers: ['Role', 'Can do'], rows: [
        ['Admin', 'Everything — including Administration (users, roles, client apps, audit).'],
        ['Designer', 'Build connectors, wizards, mappings; manage credentials.'],
        ['Operator', 'Run connections, use the wizard, manage credentials — no connector design.'],
        ['Viewer', 'Read-only access to dashboards, catalog, and monitoring.'],
      ] },
      { type: 'callout', variant: 'note', text: 'Menu items you lack permission for are hidden, and their pages redirect to the dashboard.' },
      { type: 'doclink', slug: 'users-and-roles', text: 'Admins: managing users & roles' },
    ],
  },

  // ─────────────────────────────────────────── Core Concepts
  {
    slug: 'connectors-connections-entities',
    category: 'Core Concepts',
    title: 'Connectors vs Connections vs Entities',
    desc: 'The three words you will see everywhere, clearly separated',
    keywords: 'connector connection entity difference concept model vocabulary terms',
    body: [
      { type: 'p', text: 'These three terms are the backbone of Synapse. Getting them straight makes the rest of the app obvious.' },
      { type: 'table', headers: ['Term', 'What it is', 'Analogy'], rows: [
        ['Connector', 'A reusable template describing how to talk to a system.', 'A device driver'],
        ['Connection', 'A live, configured instance wired to a real source & destination.', 'A specific cable you plugged in'],
        ['Entity', 'The canonical shape of a record that mapping targets.', 'A form template'],
      ] },
      { type: 'p', text: 'You design connectors in the Studio, you create connections with the Wizard, and you shape entities in the Catalog.' },
      { type: 'doclink', slug: 'sources-and-destinations', text: 'Next: Sources & Destinations' },
    ],
  },
  {
    slug: 'the-integration-bus',
    category: 'Core Concepts',
    title: 'The Integration Bus (Inbox / Outbox / DLQ)',
    desc: 'How every transfer flows reliably through a message bus',
    keywords: 'bus inbox outbox dlq dead letter reliability message queue how data moves',
    body: [
      { type: 'p', text: 'Every source-to-destination transfer is published onto the Integration Bus as a common-format message. There are no direct writes — this is what makes Synapse reliable.' },
      { type: 'p', text: 'The path a record travels:' },
      { type: 'code', lang: 'text', code: 'source.read() → publish → INBOX → router → OUTBOX → transform (mapping) → idempotency check → destination.dispatch()' },
      { type: 'ul', items: [
        'Inbox — records accepted from a source, waiting to be routed.',
        'Outbox — routed records waiting to be delivered to a destination.',
        'Dead Letter Queue (DLQ) — records that failed delivery (or matched no route). They are parked, never dropped, and can be replayed.',
      ] },
      { type: 'callout', variant: 'note', text: 'Because delivery is decoupled from reading, a briefly-unavailable destination never loses data — the record simply waits or lands in the DLQ.' },
      { type: 'doclink', slug: 'dead-letter-queue', text: 'Operators: the Dead Letter Queue & replay' },
      { type: 'doclink', slug: 'message-lifecycle', text: 'Related: message envelope & lifecycle' },
    ],
  },
  {
    slug: 'sources-and-destinations',
    category: 'Core Concepts',
    title: 'Sources & Destinations',
    desc: 'Where data comes from and where it goes',
    keywords: 'source destination read write connector direction plugin',
    body: [
      { type: 'p', text: 'A connector plays one of two roles in a connection: it reads (source) or it writes (destination).' },
      { type: 'ul', items: [
        'Sources — Jira (API token or browser/MFA), SharePoint lists, file shares (CSV/Excel/JSON), web scrapes.',
        'Destinations — SharePoint lists, relational databases (PostgreSQL, MySQL, SQL Server).',
      ] },
      { type: 'p', text: 'Between the two sits mapping, which reshapes each source record into the destination format.' },
      { type: 'doclink', slug: 'mapping-canvas-basics', text: 'Next: Mapping Canvas basics' },
    ],
  },
  {
    slug: 'message-lifecycle',
    category: 'Core Concepts',
    title: 'Message Envelope & Lifecycle',
    desc: 'The states a record passes through, and what each badge means',
    keywords: 'envelope lifecycle status states message monitor badge pending delivered failed',
    body: [
      { type: 'p', text: 'Each record travels as a message envelope — the data plus metadata (source, destination, natural key, timestamps). The Message Monitor shows each envelope\'s current state.' },
      { type: 'table', headers: ['State', 'Meaning'], rows: [
        ['Received', 'Accepted from the source, sitting in the inbox.'],
        ['Routed', 'Matched a subscription and moved to the outbox.'],
        ['Delivered', 'Successfully written to the destination.'],
        ['Dead-lettered', 'Delivery failed after retries, or no route matched — parked in the DLQ.'],
      ] },
      { type: 'doclink', slug: 'message-monitor', text: 'See it live: the Message Monitor' },
    ],
  },
  {
    slug: 'idempotency-and-dedup',
    category: 'Core Concepts',
    title: 'Idempotency & 3-Layer Dedup',
    desc: 'Why re-running an integration never creates duplicates',
    keywords: 'idempotency dedup duplicate natural key rerun safe replay once',
    body: [
      { type: 'p', text: 'Synapse is safe to re-run. The same record delivered twice does not create a duplicate, because delivery is idempotent and guarded by three layers of de-duplication.' },
      { type: 'ul', items: [
        'Push log — a record of what was already delivered, in the database.',
        'Item cache — a fast in-memory check of recently seen records.',
        'Destination filter — the destination dedups by natural key before writing.',
      ] },
      { type: 'callout', variant: 'tip', text: 'This is why replaying the DLQ or re-fetching is low-risk: already-delivered records are skipped.' },
    ],
  },
  {
    slug: 'smart-upsert',
    category: 'Core Concepts',
    title: 'Smart Upsert (Column-Level Diff)',
    desc: 'Only changed fields are written on update',
    keywords: 'upsert update diff column change smart write database efficient',
    body: [
      { type: 'p', text: 'When a record already exists at the destination, Synapse compares it field by field and updates only the columns that actually changed. Unchanged records are skipped entirely.' },
      { type: 'ul', items: [
        'Fewer writes — less load on the destination and faster syncs.',
        'Cleaner audit trails — "last modified" only moves when something really changed.',
      ] },
      { type: 'doclink', slug: 'delta-sync', text: 'Related: delta sync & watermarks' },
    ],
  },
  {
    slug: 'delta-sync',
    category: 'Core Concepts',
    title: 'Delta Sync & Watermarks',
    desc: 'How recurring syncs move only what changed since last time',
    keywords: 'delta sync watermark incremental schedule change since last only new',
    body: [
      { type: 'p', text: 'A delta sync moves only records that changed since the previous run. Synapse remembers a watermark (a high-water timestamp) per connection and asks the source only for records newer than it.' },
      { type: 'ul', items: [
        'A lock prevents two runs of the same connection overlapping.',
        'Terminal-status records (e.g. closed issues) can be skipped to save work.',
        'The watermark advances only after a successful run.',
      ] },
      { type: 'doclink', slug: 'scheduling-a-sync', text: 'Set one up: scheduling a recurring sync' },
    ],
  },

  // ─────────────────────────────────────────── Connection Wizard
  {
    slug: 'wizard-overview',
    category: 'Connection Wizard',
    title: 'Connection Wizard Overview',
    desc: 'The six guided steps that build a working integration',
    keywords: 'wizard overview six steps connection build guided create',
    body: [
      { type: 'p', text: 'The Wizard turns a blank slate into a running integration in six steps. Each step validates before the next unlocks, and you can go back at any time.' },
      { type: 'steps', items: [
        'Select systems', 'Credentials', 'Entities', 'Mapping', 'Fetch & review', 'Push & sync',
      ] },
      { type: 'link', to: '/wizard', text: 'Open the Connection Wizard' },
      { type: 'doclink', slug: 'wizard-select-systems', text: 'Step 1 — Select systems' },
    ],
  },
  {
    slug: 'wizard-select-systems',
    category: 'Connection Wizard',
    title: 'Step 1 — Select Systems',
    desc: 'Choose the source and destination for the integration',
    keywords: 'wizard step 1 select systems source destination choose',
    body: [
      { type: 'p', text: 'Pick where data comes from and where it goes. The source list shows every connector that can read; the destination list shows every connector that can write.' },
      { type: 'callout', variant: 'tip', text: 'If a system you need is missing, publish a connector for it first in the Connector Studio.' },
      { type: 'doclink', slug: 'wizard-credentials', text: 'Next — Step 2: Credentials' },
    ],
  },
  {
    slug: 'wizard-credentials',
    category: 'Connection Wizard',
    title: 'Step 2 — Credentials',
    desc: 'Connect and authenticate to both systems',
    keywords: 'wizard step 2 credentials auth login token test connection vault',
    body: [
      { type: 'p', text: 'Choose saved credentials from the Vault or enter new ones. Always use the Test button before continuing — it confirms Synapse can actually reach the system.' },
      { type: 'ul', items: [
        'Jira supports an API token (email + base URL + token) or a browser/MFA login.',
        'Credentials you enter here can be saved to the Vault for reuse.',
      ] },
      { type: 'doclink', slug: 'jira-auth-methods', text: 'Jira: API token vs Browser/MFA' },
      { type: 'doclink', slug: 'credential-vault', text: 'About the Credential Vault' },
    ],
  },
  {
    slug: 'wizard-entities',
    category: 'Connection Wizard',
    title: 'Step 3 — Entities',
    desc: 'Choose which records to move',
    keywords: 'wizard step 3 entities select records issues objects which data',
    body: [
      { type: 'p', text: 'Select the entities to sync — for Jira that might be issues, worklogs, sprints, or comments. Synapse discovers what the source offers and lets you pick.' },
      { type: 'doclink', slug: 'entity-catalog', text: 'Related: the Master Entity Catalog' },
      { type: 'doclink', slug: 'wizard-mapping', text: 'Next — Step 4: Mapping' },
    ],
  },
  {
    slug: 'wizard-mapping',
    category: 'Connection Wizard',
    title: 'Step 4 — Mapping',
    desc: 'Line up source fields with destination columns',
    keywords: 'wizard step 4 mapping fields map columns transform preset',
    body: [
      { type: 'p', text: 'Map each source field to a destination column. Start from an auto-suggested mapping, then refine: apply presets, add joins or lookups, or write a custom expression for a field.' },
      { type: 'doclink', slug: 'field-mapping-presets', text: 'Field mapping presets' },
      { type: 'doclink', slug: 'joins-and-lookups', text: 'Joins & lookups' },
      { type: 'doclink', slug: 'custom-js-expressions', text: 'Custom JS expressions' },
    ],
  },
  {
    slug: 'wizard-fetch-review',
    category: 'Connection Wizard',
    title: 'Step 5 — Fetch & Review',
    desc: 'Pull a sample and confirm before anything is written',
    keywords: 'wizard step 5 fetch review sample preview confirm dry run safe',
    body: [
      { type: 'p', text: 'Synapse fetches real records and shows you exactly how they will look after mapping — before writing anything. Use this to catch mapping mistakes early.' },
      { type: 'callout', variant: 'note', text: 'This step is always safe: it reads and previews only. Your destination is untouched until Step 6.' },
      { type: 'doclink', slug: 'wizard-push-sync', text: 'Next — Step 6: Push & sync' },
    ],
  },
  {
    slug: 'wizard-push-sync',
    category: 'Connection Wizard',
    title: 'Step 6 — Push & Sync',
    desc: 'Deliver the records and optionally schedule recurring runs',
    keywords: 'wizard step 6 push sync deliver write schedule run publish',
    body: [
      { type: 'p', text: 'This step publishes your mapped records onto the bus for delivery to the destination. Watch progress live, then optionally turn on a schedule so the connection keeps itself up to date.' },
      { type: 'callout', variant: 'tip', text: 'Delivery goes through the bus, so a large push is resilient — failures land in the DLQ for replay rather than aborting the run.' },
      { type: 'doclink', slug: 'scheduling-a-sync', text: 'Set a recurring schedule' },
      { type: 'doclink', slug: 'dead-letter-queue', text: 'If some records fail: the DLQ' },
    ],
  },
  {
    slug: 'session-recorder',
    category: 'Connection Wizard',
    title: 'Recording an Auth Session (2FA / MFA)',
    desc: 'Capture a browser login so Synapse can reach systems behind SSO',
    keywords: 'session recorder browser mfa 2fa sso playwright login capture cookie',
    body: [
      { type: 'p', text: 'Some systems require a human login with two-factor authentication. The Session Recorder opens a real browser where you sign in once; Synapse then reuses that authenticated session to fetch data.' },
      { type: 'steps', items: [
        'Start the recorder from the credentials step.',
        'Complete the login, including any 2FA/MFA prompt, in the opened browser.',
        'Finish recording — the session is cached and reused for fetches.',
      ] },
      { type: 'callout', variant: 'note', text: 'Each operator brings their own login; sessions are not shared between users.' },
    ],
  },
  {
    slug: 'scheduling-a-sync',
    category: 'Connection Wizard',
    title: 'Scheduling a Recurring Sync',
    desc: 'Keep a connection up to date automatically',
    keywords: 'schedule recurring sync cron automatic interval keep updated delta',
    body: [
      { type: 'p', text: 'A schedule runs a connection automatically at a set interval, moving only what changed since last time (a delta sync). Manage schedules from the Push & sync step or from My Connections.' },
      { type: 'doclink', slug: 'delta-sync', text: 'How incremental runs work: delta sync' },
      { type: 'link', to: '/connected', text: 'Manage schedules in My Connections' },
    ],
  },

  // ─────────────────────────────────────────── Mapping
  {
    slug: 'mapping-canvas-basics',
    category: 'Mapping',
    title: 'Mapping Canvas Basics',
    desc: 'The visual field-to-field editor for shaping data',
    keywords: 'mapping canvas visual fields map drag connect editor',
    body: [
      { type: 'p', text: 'The Mapping Canvas is a visual editor where you connect source fields on the left to destination columns on the right. It is the same mapping the Wizard uses, in a larger workspace.' },
      { type: 'link', to: '/canvas', text: 'Open the Mapping Canvas' },
      { type: 'ul', items: [
        'Direct maps — copy a source field straight to a column.',
        'Presets — apply a reusable transform (formatting, defaults, lookups).',
        'Expressions — compute a value with a small JavaScript snippet.',
      ] },
      { type: 'doclink', slug: 'field-mapping-presets', text: 'Next: field mapping presets' },
    ],
  },
  {
    slug: 'field-mapping-presets',
    category: 'Mapping',
    title: 'Field Mapping Presets',
    desc: 'Reusable transforms for common mapping needs',
    keywords: 'preset mapping transform format default constant concat lookup reuse',
    body: [
      { type: 'p', text: 'Presets are named, configurable transforms you attach to a field so you don\'t rewrite the same logic. Common presets include constants/defaults, string formatting, concatenation, and lookups.' },
      { type: 'callout', variant: 'tip', text: 'Presets are previewed live in Fetch & review, so you can confirm the output before pushing.' },
      { type: 'doclink', slug: 'joins-and-lookups', text: 'For cross-entity data: joins & lookups' },
    ],
  },
  {
    slug: 'custom-js-expressions',
    category: 'Mapping',
    title: 'Custom JavaScript Expressions',
    desc: 'Compute a field value with a sandboxed snippet',
    keywords: 'expression javascript js custom code sandbox transform compute formula',
    body: [
      { type: 'p', text: 'When a preset isn\'t enough, write a small JavaScript expression to compute a field. Expressions run in a secure sandbox with no access to the network, filesystem, or system globals, and are limited in time and memory.' },
      { type: 'code', lang: 'javascript', code: '// `row` is the source record. Return the value for this field.\nreturn (row.firstName + " " + row.lastName).trim();' },
      { type: 'callout', variant: 'warn', text: 'Expressions cannot call out to other systems — they only transform the current record. Use joins/lookups to bring in data from elsewhere.' },
    ],
  },
  {
    slug: 'joins-and-lookups',
    category: 'Mapping',
    title: 'Joins & Lookups',
    desc: 'Enrich, resolve, and aggregate across entities',
    keywords: 'join lookup aggregate enrich cross entity reference foreign key relate combine',
    body: [
      { type: 'p', text: 'Joins let a mapping pull in data from another entity. Configure them in the Joins panel of the Wizard or Canvas. There are three intents:' },
      { type: 'table', headers: ['Intent', 'Use it to'], rows: [
        ['Enrichment', 'Add related columns to each record (e.g. project name onto an issue).'],
        ['Lookup', 'Resolve a reference (e.g. a text name → a foreign-key id).'],
        ['Aggregate', 'Roll up many child rows into one value (e.g. total worklog hours).'],
      ] },
      { type: 'p', text: 'Reference joined columns in a mapping with the @join syntax, e.g. @join.project.name.' },
      { type: 'doclink', slug: 'multi-target-fan-out', text: 'Related: multi-target fan-out' },
    ],
  },
  {
    slug: 'multi-target-fan-out',
    category: 'Mapping',
    title: 'Multi-Target Fan-Out',
    desc: 'Send one entity to more than one destination',
    keywords: 'fan out multi target split merge multiple destinations column shared table',
    body: [
      { type: 'p', text: 'Fan-out delivers a single source entity to two or more destination targets at once — for example splitting columns across two tables, or merging records into a shared table.' },
      { type: 'ul', items: [
        'Column-split — different columns of a record go to different targets.',
        'Shared-table merge — several sources converge into one destination table.',
      ] },
      { type: 'doclink', slug: 'joins-and-lookups', text: 'Often paired with joins & lookups' },
    ],
  },
  {
    slug: 'field-level-encryption',
    category: 'Mapping',
    title: 'Field-Level Encryption',
    desc: 'Encrypt sensitive fields before they reach the destination',
    keywords: 'encryption field aes encrypt sensitive pii secure mask reveal',
    body: [
      { type: 'p', text: 'You can mark individual fields for encryption. Synapse encrypts them (AES-256-GCM) as a step in the mapping pipeline, so sensitive values are protected before they are written to the destination.' },
      { type: 'ul', items: [
        'Encryption is a non-breaking step applied after mapping.',
        'A separate audited reveal endpoint lets authorized users read the original value when needed.',
      ] },
      { type: 'callout', variant: 'note', text: 'Encryption keys are managed server-side; the plaintext never leaves the pipeline in the clear.' },
      { type: 'doclink', slug: 'audit-log', text: 'Reveals are recorded in the audit log' },
    ],
  },

  // ─────────────────────────────────────────── Connectors (Studio)
  {
    slug: 'connector-studio-overview',
    category: 'Connectors',
    title: 'Connector Studio Overview',
    desc: 'Design and publish the templates that power connections',
    keywords: 'studio connector design template publish build author category',
    body: [
      { type: 'p', text: 'The Connector Studio is where designers build connector templates — the reusable definitions of how Synapse talks to a system and what entities/fields it exposes. Published connectors become available in the Wizard.' },
      { type: 'link', to: '/studio', text: 'Open the Connector Studio' },
      { type: 'doclink', slug: 'building-a-connector', text: 'Next: building & publishing a connector' },
    ],
  },
  {
    slug: 'building-a-connector',
    category: 'Connectors',
    title: 'Building & Publishing a Connector',
    desc: 'From draft to a published, usable connector template',
    keywords: 'build connector publish draft save template create new studio',
    body: [
      { type: 'p', text: 'A connector goes from draft to published. In the Studio you configure the system category, authentication, and the entities/fields it offers, then publish it so operators can use it.' },
      { type: 'steps', items: [
        'Create a draft and choose a system category.',
        'Configure authentication and connection settings.',
        'Define entities and their fields (or record them from a live session).',
        'Save the draft, verify, then Publish.',
      ] },
      { type: 'callout', variant: 'warn', text: 'Publishing makes the connector available to build connections from — review entities and fields before you publish.' },
      { type: 'doclink', slug: 'editing-entities-fields', text: 'Detail: editing entities & fields' },
    ],
  },
  {
    slug: 'editing-entities-fields',
    category: 'Connectors',
    title: 'Editing Entities & Fields',
    desc: 'Rename labels, set types, mark required fields and keys',
    keywords: 'entity field edit label type required primary key canonical studio',
    body: [
      { type: 'p', text: 'For each entity a connector exposes, you can shape its fields:' },
      { type: 'ul', items: [
        'Label — a friendly display name.',
        'Canonical type — the data type mapping understands (string, number, date…).',
        'Required — whether the field must be present.',
        'Primary key — the natural key used for de-duplication and upserts.',
      ] },
      { type: 'doclink', slug: 'primary-keys', text: 'Why keys matter: primary & natural keys' },
    ],
  },
  {
    slug: 'web-scrape-recorder',
    category: 'Connectors',
    title: 'Web-Scrape / Crawl Recorder',
    desc: 'Turn a browsing session into a data-extracting connector',
    keywords: 'scrape crawl recorder browser record highlight extract entity web capture',
    body: [
      { type: 'p', text: 'For systems without an API, the Crawl Recorder lets an author log in and browse while highlighting the values to capture. Those highlights become entities and fields the connector can extract on every run.' },
      { type: 'steps', items: [
        'Record a login and navigate to the data.',
        'Highlight the values you want; group them into entities.',
        'Save — the recorded steps drive future automated crawls.',
      ] },
      { type: 'callout', variant: 'note', text: 'Operators bring their own authentication when they run a scrape connection, including 2FA where required.' },
      { type: 'doclink', slug: 'session-recorder', text: 'Related: recording an auth session' },
    ],
  },
  {
    slug: 'connector-categories',
    category: 'Connectors',
    title: 'Connector Categories',
    desc: 'The families of systems Synapse can connect to',
    keywords: 'category connector type family database file share api scrape sharepoint jira',
    body: [
      { type: 'p', text: 'Connectors are organized by category so you can find the right one quickly. Common categories include:' },
      { type: 'ul', items: [
        'Issue trackers — Jira (API token or browser/MFA).',
        'Collaboration — SharePoint lists & libraries (source and destination).',
        'Databases — PostgreSQL, MySQL, SQL Server.',
        'File shares — SFTP, local, S3/MinIO, Azure, Google Drive (CSV/Excel/JSON).',
        'Web scrape — recorded browser crawls for API-less systems.',
      ] },
    ],
  },

  // ─────────────────────────────────────────── Entities (Catalog)
  {
    slug: 'entity-catalog',
    category: 'Entities',
    title: 'Master Entity Catalog',
    desc: 'The canonical data model shared across all connectors',
    keywords: 'catalog entity master canonical model schema shared groups',
    body: [
      { type: 'p', text: 'The Entity Catalog is the shared vocabulary of your data — the canonical entities (and their fields) that mappings target regardless of which system the data came from.' },
      { type: 'link', to: '/catalog', text: 'Open the Entity Catalog' },
      { type: 'doclink', slug: 'canonical-types', text: 'Next: canonical types' },
    ],
  },
  {
    slug: 'canonical-types',
    category: 'Entities',
    title: 'Canonical Types',
    desc: 'The neutral data types mapping uses',
    keywords: 'canonical type data string number date boolean neutral field',
    body: [
      { type: 'p', text: 'Every field has a canonical type — a system-neutral type (string, number, date, boolean, and so on). Mapping uses canonical types so a field from Jira and a column in SQL Server can line up cleanly.' },
      { type: 'doclink', slug: 'mapping-canvas-basics', text: 'How types are used: Mapping Canvas' },
    ],
  },
  {
    slug: 'primary-keys',
    category: 'Entities',
    title: 'Primary & Natural Keys',
    desc: 'The field that identifies a record uniquely',
    keywords: 'primary key natural key unique identity dedup upsert id',
    body: [
      { type: 'p', text: 'A primary (natural) key uniquely identifies a record — an issue key, an email, an id. Synapse uses it to decide whether an incoming record is new (insert) or already exists (update), and to prevent duplicates.' },
      { type: 'callout', variant: 'warn', text: 'Choose a stable natural key. If it changes, Synapse will treat the record as new.' },
      { type: 'doclink', slug: 'idempotency-and-dedup', text: 'Related: idempotency & dedup' },
    ],
  },

  // ─────────────────────────────────────────── Operations & Monitoring
  {
    slug: 'health-dashboard-ops',
    category: 'Operations',
    title: 'Health Dashboard (for Operators)',
    desc: 'Use the dashboard to keep integrations healthy',
    keywords: 'dashboard operations health monitor status operator overview',
    body: [
      { type: 'p', text: 'Operators live on the Health Dashboard. It surfaces failing integrations, throughput trends, and recent errors, each linking to the detail you need to act.' },
      { type: 'link', to: '/dashboard', text: 'Open the Health Dashboard' },
      { type: 'doclink', slug: 'message-monitor', text: 'Drill in: the Message Monitor' },
    ],
  },
  {
    slug: 'message-monitor',
    category: 'Operations',
    title: 'Message Monitor',
    desc: 'Watch records flow through the bus in real time',
    keywords: 'monitor message console flow status badge envelope runs logs trading network',
    body: [
      { type: 'p', text: 'The Message Monitor shows live message flow through the Integration Bus, each envelope tagged with its current status. Use it to confirm a run is delivering, or to find the ones that failed.' },
      { type: 'link', to: '/monitor', text: 'Open the Message Monitor' },
      { type: 'doclink', slug: 'message-lifecycle', text: 'What the badges mean: message lifecycle' },
      { type: 'doclink', slug: 'dead-letter-queue', text: 'Handle failures: the Dead Letter Queue' },
    ],
  },
  {
    slug: 'dead-letter-queue',
    category: 'Operations',
    title: 'Dead Letter Queue & Replay',
    desc: 'Find failed messages and safely replay them',
    keywords: 'dlq dead letter queue replay failed retry recover parked unrouted',
    body: [
      { type: 'p', text: 'The Dead Letter Queue holds messages that failed delivery or matched no route. Nothing is ever silently dropped — it lands here so you can inspect and replay it.' },
      { type: 'steps', items: [
        'Open the Dead Letter panel from the Message Monitor.',
        'Inspect a failed message to see why it stopped.',
        'Fix the underlying cause (credentials, mapping, destination).',
        'Replay a single message or all of them.',
      ] },
      { type: 'callout', variant: 'tip', text: 'Replay is safe: idempotency means already-delivered records won\'t be duplicated.' },
      { type: 'doclink', slug: 'the-integration-bus', text: 'Background: the Integration Bus' },
    ],
  },
  {
    slug: 'integration-registry',
    category: 'Operations',
    title: 'Integration Registry',
    desc: 'The catalog of every configured integration',
    keywords: 'registry integration list adapters deployed catalog configured',
    body: [
      { type: 'p', text: 'The Integration Registry lists every configured integration and adapter in one place — a design-time catalog you can browse, search, and open for detail.' },
      { type: 'link', to: '/registry', text: 'Open the Integration Registry' },
      { type: 'doclink', slug: 'my-connections', text: 'Related: My Connections' },
    ],
  },
  {
    slug: 'my-connections',
    category: 'Operations',
    title: 'My Connections',
    desc: 'Run, pause, schedule, clone, and manage live connections',
    keywords: 'my connections connected instances run pause schedule clone delete logs manage',
    body: [
      { type: 'p', text: 'My Connections is the control panel for your live integration instances. Each row shows status and schedule, with per-connection actions.' },
      { type: 'ul', items: [
        'Run — trigger a sync now.',
        'Pause / Resume — stop or restart a schedule.',
        'Clone — copy a connection as a starting point for a new one.',
        'Delete — remove a connection.',
        'Logs — open its run history and message flow.',
      ] },
      { type: 'link', to: '/connected', text: 'Open My Connections' },
    ],
  },

  // ─────────────────────────────────────────── Alerts
  {
    slug: 'alerts-overview',
    category: 'Alerts',
    title: 'Alerts Overview',
    desc: 'How Synapse tells you something needs attention',
    keywords: 'alerts overview notifications warnings unresolved rules attention',
    body: [
      { type: 'p', text: 'The Alerts page collects conditions that need your attention — failures, expiring credentials, latency spikes — with a count of unresolved items and actions to resolve them.' },
      { type: 'link', to: '/alerts', text: 'Open Alerts' },
      { type: 'doclink', slug: 'creating-alert-rules', text: 'Next: creating alert rules' },
    ],
  },
  {
    slug: 'creating-alert-rules',
    category: 'Alerts',
    title: 'Creating Alert Rules',
    desc: 'Define thresholds that trigger notifications',
    keywords: 'alert rule create threshold latency error rate throughput trigger',
    body: [
      { type: 'p', text: 'An alert rule watches a metric and fires when it crosses a threshold you set — for example error rate above 5%, or latency above a limit.' },
      { type: 'steps', items: [
        'Open Alerts and choose to create a rule.',
        'Pick the metric (latency, error rate, throughput…).',
        'Set the threshold and the notification channel.',
        'Save — the rule begins watching immediately.',
      ] },
      { type: 'doclink', slug: 'notification-channels', text: 'Next: notification channels' },
    ],
  },
  {
    slug: 'notification-channels',
    category: 'Alerts',
    title: 'Notification Channels',
    desc: 'Where alerts are delivered',
    keywords: 'notification channel email slack webhook alert deliver dispatch',
    body: [
      { type: 'p', text: 'Alerts can be delivered to email, Slack, or a webhook. A background dispatcher sends notifications as rules fire, so the right people hear about problems quickly.' },
      { type: 'doclink', slug: 'resolving-alerts', text: 'Next: resolving alerts' },
    ],
  },
  {
    slug: 'resolving-alerts',
    category: 'Alerts',
    title: 'Resolving Alerts',
    desc: 'Acknowledge and clear alerts once handled',
    keywords: 'resolve alert acknowledge clear close handled fixed',
    body: [
      { type: 'p', text: 'When you\'ve handled the underlying issue, resolve the alert to clear it from the unresolved list. The action is recorded so there\'s a trail of who resolved what.' },
      { type: 'doclink', slug: 'audit-log', text: 'Where actions are recorded: audit log' },
    ],
  },

  // ─────────────────────────────────────────── Security & Credentials
  {
    slug: 'credential-vault',
    category: 'Security',
    title: 'Credential Vault',
    desc: 'Store, reveal, rotate, and revoke secrets safely',
    keywords: 'vault credential secret key token store reveal rotate revoke expiry encrypt',
    body: [
      { type: 'p', text: 'The Credential Vault securely stores the API keys, tokens, and passwords your connections need. Secrets are encrypted at rest (AES-256-GCM) and every access is audit-logged.' },
      { type: 'ul', items: [
        'Time-limited reveal — see a secret briefly when you must, with the reveal recorded.',
        'Copy without reveal — copy a value to the clipboard without displaying it.',
        'Rotate — replace a secret without breaking connections that reference it.',
        'Revoke — disable a secret immediately.',
        'Expiry alerts — get warned before a credential expires.',
      ] },
      { type: 'link', to: '/vault', text: 'Open the Credential Vault' },
      { type: 'doclink', slug: 'audit-log', text: 'Every access is logged: audit log' },
    ],
  },
  {
    slug: 'security-field-encryption',
    category: 'Security',
    title: 'Field-Level Encryption (Security)',
    desc: 'Protect sensitive record fields end to end',
    keywords: 'encryption field security sensitive pii protect aes reveal audited',
    body: [
      { type: 'p', text: 'Beyond credentials, individual data fields can be encrypted as they move through a connection, so sensitive values are never written to a destination in the clear.' },
      { type: 'doclink', slug: 'field-level-encryption', text: 'How to set it up: field-level encryption' },
    ],
  },
  {
    slug: 'audit-log',
    category: 'Security',
    title: 'Audit Log',
    desc: 'A record of who did what, and when',
    keywords: 'audit log trail history who changed action record accountability',
    body: [
      { type: 'p', text: 'The audit log records sensitive actions across the platform — credential reveals, configuration changes, logins — so you always have an accountable trail. Admins browse it from the Administration page.' },
      { type: 'link', to: '/admin', text: 'Open Administration' },
      { type: 'doclink', slug: 'audit-trail', text: 'Admin view: the audit trail' },
    ],
  },

  // ─────────────────────────────────────────── Administration
  {
    slug: 'users-and-roles',
    category: 'Administration',
    title: 'Users & Roles (RBAC)',
    desc: 'Manage who can access what',
    keywords: 'users roles rbac admin permissions access manage add remove assign',
    body: [
      { type: 'p', text: 'Admins manage users and assign roles that control access across the app. Add or remove users, change roles, and enforce least-privilege from one place.' },
      { type: 'link', to: '/admin', text: 'Open Administration' },
      { type: 'doclink', slug: 'roles-at-a-glance', text: 'What each role can do' },
    ],
  },
  {
    slug: 'client-applications',
    category: 'Administration',
    title: 'Client Applications',
    desc: 'Manage programmatic access to Synapse',
    keywords: 'client app api access token machine integration programmatic admin',
    body: [
      { type: 'p', text: 'Client applications represent non-human callers — scripts or services that talk to Synapse programmatically. Admins register them and control their access.' },
      { type: 'link', to: '/admin', text: 'Open Administration' },
    ],
  },
  {
    slug: 'audit-trail',
    category: 'Administration',
    title: 'Audit Trail',
    desc: 'Review the platform-wide action history',
    keywords: 'audit trail admin history actions review log viewer',
    body: [
      { type: 'p', text: 'The audit trail viewer in Administration lets admins search the full history of sensitive actions — filter by user, action, or time to investigate an event.' },
      { type: 'doclink', slug: 'audit-log', text: 'Background: the audit log' },
    ],
  },
  {
    slug: 'login-and-auth',
    category: 'Administration',
    title: 'Login & Authentication',
    desc: 'How signing in works',
    keywords: 'login auth authentication sign in jwt password session token',
    body: [
      { type: 'p', text: 'Synapse uses token-based login. You sign in with your email and password; a session token then authorizes your requests. Your role is attached to the session and drives what you can see.' },
      { type: 'callout', variant: 'note', text: 'In development the default admin login is admin@synapse.local / admin12345.' },
      { type: 'doclink', slug: 'roles-at-a-glance', text: 'After login: roles at a glance' },
    ],
  },

  // ─────────────────────────────────────────── Troubleshooting
  {
    slug: 'common-error-codes',
    category: 'Troubleshooting',
    title: 'Common Error Codes',
    desc: 'Decode the errors you are most likely to hit',
    keywords: 'error code troubleshoot 400 401 403 404 429 500 502 503 fix meaning http',
    body: [
      { type: 'p', text: 'Errors follow standard HTTP conventions: 4xx means the request had a problem (auth, permissions, bad input), 5xx means the far side failed.' },
      { type: 'table', headers: ['Code', 'Meaning', 'Usual fix'], rows: [
        ['400', 'Bad request / invalid input', 'Check mapping and required fields.'],
        ['401', 'Not authenticated', 'Re-enter or rotate the credential; re-test.'],
        ['403', 'Not authorized', 'The account lacks permission on the target system.'],
        ['404', 'Not found', 'Check the list/table/URL exists and the name is exact.'],
        ['429', 'Rate limited', 'Slow the run or schedule; the bus will retry.'],
        ['5xx', 'Destination/server error', 'Transient — records go to the DLQ for replay.'],
      ] },
      { type: 'doclink', slug: 'retry-and-dlq', text: 'What happens on failure: retry & DLQ' },
    ],
  },
  {
    slug: 'retry-and-dlq',
    category: 'Troubleshooting',
    title: 'Retry & DLQ Handling',
    desc: 'What Synapse does automatically when delivery fails',
    keywords: 'retry backoff dlq dead letter fail delivery automatic recover replay',
    body: [
      { type: 'p', text: 'When a delivery fails, Synapse retries with backoff. If it still can\'t succeed, the message is dead-lettered rather than lost — you can inspect and replay it once the cause is fixed.' },
      { type: 'doclink', slug: 'dead-letter-queue', text: 'Replay them: the Dead Letter Queue' },
      { type: 'doclink', slug: 'idempotency-and-dedup', text: 'Why replay is safe: idempotency' },
    ],
  },
  {
    slug: 'performance-tuning',
    category: 'Troubleshooting',
    title: 'Performance Tuning',
    desc: 'Make large syncs faster and lighter',
    keywords: 'performance tuning slow speed throughput latency optimize batch schedule',
    body: [
      { type: 'p', text: 'If a sync is slow or heavy, a few levers help:' },
      { type: 'ul', items: [
        'Prefer delta syncs so each run moves only what changed.',
        'Rely on smart upsert — unchanged records are skipped automatically.',
        'Spread large loads across a schedule instead of one massive push.',
        'Trim mappings and joins to only the fields you actually need.',
      ] },
      { type: 'doclink', slug: 'delta-sync', text: 'Related: delta sync & watermarks' },
      { type: 'doclink', slug: 'smart-upsert', text: 'Related: smart upsert' },
    ],
  },
  {
    slug: 'connection-test-failed',
    category: 'Troubleshooting',
    title: '"Connection Test Failed"',
    desc: 'Work through a failing credential/connection test',
    keywords: 'connection test failed credential auth cannot connect troubleshoot vault',
    body: [
      { type: 'p', text: 'A failed test means Synapse couldn\'t reach or authenticate to the system. Check, in order:' },
      { type: 'steps', items: [
        'Credentials — are they current? Rotate or re-enter and test again.',
        'URL / base address — exact host, no typos, reachable from the server.',
        'Permissions — does the account have access to the target list/table?',
        'For SSO/MFA systems — re-record the browser session.',
      ] },
      { type: 'doclink', slug: 'jira-auth-methods', text: 'Jira specifics: API token vs Browser/MFA' },
      { type: 'doclink', slug: 'sharepoint-graph-errors', text: 'SharePoint specifics: Graph errors' },
    ],
  },
  {
    slug: 'jira-auth-methods',
    category: 'Troubleshooting',
    title: 'Jira Auth: API Token vs Browser/MFA',
    desc: 'Choose and fix the right Jira connection method',
    keywords: 'jira auth api token browser mfa duo sso playwright login connect',
    body: [
      { type: 'p', text: 'Synapse can connect to Jira two ways. Pick based on how your Jira is secured.' },
      { type: 'table', headers: ['Method', 'When to use', 'If it fails'], rows: [
        ['API token', 'Standard Jira with token access.', 'Regenerate the token; verify email + base URL.'],
        ['Browser / MFA', 'Jira behind SSO / 2FA (e.g. Duo).', 'Re-record the session; the cached login may have expired.'],
      ] },
      { type: 'doclink', slug: 'session-recorder', text: 'For MFA: recording an auth session' },
    ],
  },
  {
    slug: 'sharepoint-graph-errors',
    category: 'Troubleshooting',
    title: 'SharePoint / Graph Errors',
    desc: 'Fix common SharePoint push and list errors',
    keywords: 'sharepoint graph error list column push permission field type microsoft',
    body: [
      { type: 'p', text: 'SharePoint pushes go through Microsoft Graph. Common causes of errors:' },
      { type: 'ul', items: [
        'Wrong list name or the list doesn\'t exist — names are exact and case-sensitive.',
        'A destination column is missing or has an incompatible type.',
        'The account lacks write permission on the list.',
        'A required column has no mapped value.',
      ] },
      { type: 'callout', variant: 'tip', text: 'Use Fetch & review to confirm mapped values match the list\'s column types before pushing.' },
      { type: 'doclink', slug: 'wizard-fetch-review', text: 'Preview first: Fetch & review' },
    ],
  },

  // ─────────────────────────────────────────── Reference
  {
    slug: 'glossary',
    category: 'Reference',
    title: 'Glossary',
    desc: 'Every Synapse term in one place',
    keywords: 'glossary terms definitions vocabulary meaning dictionary reference',
    body: [
      { type: 'table', headers: ['Term', 'Definition'], rows: [
        ['Connector', 'A reusable template for talking to a system.'],
        ['Connection', 'A configured, live instance of a connector.'],
        ['Entity', 'The canonical shape of a record.'],
        ['Bus', 'The reliable message pipeline all transfers flow through.'],
        ['Inbox / Outbox', 'Staging queues before routing / before delivery.'],
        ['DLQ', 'Dead Letter Queue — parked failed or unrouted messages.'],
        ['Envelope', 'A record plus its routing metadata on the bus.'],
        ['Idempotency', 'The property that re-delivering a record causes no duplicate.'],
        ['Upsert', 'Insert-or-update; here, column-level (only changed fields).'],
        ['Delta sync', 'A run that moves only records changed since a watermark.'],
        ['Watermark', 'The high-water timestamp marking the last successful sync.'],
        ['Natural key', 'The field that uniquely identifies a record.'],
      ] },
    ],
  },
  {
    slug: 'keyboard-and-search',
    category: 'Reference',
    title: 'Keyboard Shortcuts & Global Search',
    desc: 'Move faster with the keyboard and top search',
    keywords: 'keyboard shortcut search escape enter navigate quick jump help',
    body: [
      { type: 'p', text: 'The topbar search jumps to any page, connector, connection, or entity — type and press Enter for the first match, Escape to dismiss.' },
      { type: 'ul', items: [
        'Esc — close the Help drawer, a modal, or the detail pane.',
        'Enter — in search, open the top result.',
      ] },
      { type: 'doclink', slug: 'navigating-synapse', text: 'Related: navigating the app' },
    ],
  },
  {
    slug: 'api-endpoints',
    category: 'Reference',
    title: 'Bus & API Endpoints',
    desc: 'The main endpoints behind the data-transfer path',
    keywords: 'api endpoint rest bus run integration publish dlq reference developer',
    body: [
      { type: 'p', text: 'For developers and integrators, the key data-transfer endpoints are:' },
      { type: 'table', headers: ['Endpoint', 'Purpose'], rows: [
        ['POST /api/hub/run-integration/:id', 'Read a source and publish onto the bus.'],
        ['POST /api/hub/publish-records', 'Deliver mapped rows via the bus.'],
        ['GET /api/hub/run-status/:runId', 'Check the status of a run.'],
        ['POST /api/hub/cancel-run/:runId', 'Cancel an in-flight run.'],
        ['POST /api/ingest/:token', 'Inbound webhook → bus.'],
        ['/api/hub/dlq', 'Inspect and replay the Dead Letter Queue.'],
      ] },
      { type: 'callout', variant: 'note', text: 'All egress goes through the bus — there are no direct destination-write endpoints.' },
    ],
  },
  {
    slug: 'faq',
    category: 'Reference',
    title: 'Frequently Asked Questions',
    desc: 'Quick answers to the most common questions',
    keywords: 'faq questions answers common help how do i safe rerun duplicate',
    body: [
      { type: 'h2', text: 'Is it safe to re-run an integration?' },
      { type: 'p', text: 'Yes. Idempotency and de-duplication mean re-running never creates duplicates.' },
      { type: 'h2', text: 'Where do failed records go?' },
      { type: 'p', text: 'To the Dead Letter Queue, where you can inspect and replay them. Nothing is dropped.' },
      { type: 'h2', text: 'Can I preview before writing?' },
      { type: 'p', text: 'Always — the Fetch & review step shows mapped data before anything is delivered.' },
      { type: 'h2', text: 'Why can\'t I see a menu item?' },
      { type: 'p', text: 'Your role likely doesn\'t include it. See Roles at a glance.' },
      { type: 'doclink', slug: 'roles-at-a-glance', text: 'Roles at a glance' },
    ],
  },
];

// Ordered category list, derived from the article order above (first appearance wins).
export const helpCategories = helpArticles.reduce((cats, a) => {
  if (!cats.includes(a.category)) cats.push(a.category);
  return cats;
}, []);

/** Look up a single article by its slug. Returns undefined if not found. */
export function getArticle(slug) {
  return helpArticles.find((a) => a.slug === slug);
}

// Flatten an article's body blocks into plain searchable text.
function articleText(a) {
  const parts = [a.title, a.desc, a.keywords || ''];
  for (const b of a.body || []) {
    if (b.text) parts.push(b.text);
    if (b.items) parts.push(b.items.join(' '));
    if (b.headers) parts.push(b.headers.join(' '));
    if (b.rows) parts.push(b.rows.flat().join(' '));
    if (b.code) parts.push(b.code);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Rank articles against a free-text query. Title/desc/keyword hits weigh more
 * than body hits. Returns articles sorted best-first; empty query → [].
 */
export function searchArticles(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = helpArticles.map((a) => {
    const hay = articleText(a);
    const titleHay = `${a.title} ${a.desc} ${a.keywords || ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!hay.includes(t)) continue;
      score += 1;
      if (titleHay.includes(t)) score += 3;
      if (a.title.toLowerCase().includes(t)) score += 4;
    }
    // Whole-phrase bonus.
    if (a.title.toLowerCase().includes(q)) score += 6;
    return { article: a, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.article);
}
