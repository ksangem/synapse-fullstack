"""Generate 3 BRD architecture diagrams as PNGs.

Outputs: diagrams/{architecture,module_flow,data_flow}.png
"""
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle
from matplotlib.lines import Line2D
from pathlib import Path

OUT = Path(__file__).parent / "diagrams"
OUT.mkdir(exist_ok=True)

# ND palette
NAVY = "#002060"
DEEP = "#102898"
ORANGE = "#FF9933"
LIGHT = "#EDF2FC"
ALTROW = "#EBF3FB"
TEAL = "#156082"
WHITE = "#FFFFFF"
GREY = "#595959"
LTBLUE = "#B8D0F8"
RAG_GREEN = "#2D6A4F"
RAG_AMBER = "#B45309"
RAG_RED = "#991B1B"


def box(ax, x, y, w, h, label, fill=NAVY, fg=WHITE, fontsize=9, bold=True):
    p = FancyBboxPatch((x, y), w, h,
                       boxstyle="round,pad=0.02,rounding_size=0.08",
                       linewidth=1.2, edgecolor=NAVY, facecolor=fill)
    ax.add_patch(p)
    weight = "bold" if bold else "normal"
    ax.text(x + w / 2, y + h / 2, label, ha="center", va="center",
            color=fg, fontsize=fontsize, weight=weight, wrap=True)


def arrow(ax, x1, y1, x2, y2, label=None, color=NAVY, style="->", lw=1.4):
    a = FancyArrowPatch((x1, y1), (x2, y2),
                        arrowstyle=style, color=color, lw=lw,
                        mutation_scale=14, connectionstyle="arc3,rad=0")
    ax.add_patch(a)
    if label:
        mx, my = (x1 + x2) / 2, (y1 + y2) / 2
        ax.text(mx, my, label, ha="center", va="center",
                fontsize=7.5, color=GREY,
                bbox=dict(boxstyle="round,pad=0.18", facecolor=WHITE, edgecolor="none", alpha=0.92))


def band(ax, x, y, w, h, label, color):
    ax.add_patch(Rectangle((x, y), w, h, facecolor=color, edgecolor="none", alpha=0.18))
    ax.text(x + 0.1, y + h - 0.18, label, fontsize=9, weight="bold", color=NAVY)


# ================================================================
# DIAGRAM 1 — HIGH-LEVEL SYSTEM ARCHITECTURE
# ================================================================
fig, ax = plt.subplots(figsize=(13, 8.0))
ax.set_xlim(0, 14)
ax.set_ylim(0, 9)
ax.axis("off")
ax.set_title("Xn Hub — High-Level System Architecture",
             fontsize=14, weight="bold", color=NAVY, pad=14)

# Bands
band(ax, 0.3, 7.4, 13.4, 1.2, "External Systems", LTBLUE)
band(ax, 0.3, 5.4, 13.4, 1.7, "Frontend (React 19 + Vite, port 5173)", ORANGE)
band(ax, 0.3, 2.6, 13.4, 2.5, "Backend (Express 5 + TS, port 4000)", LIGHT)
band(ax, 0.3, 0.2, 13.4, 2.0, "Persistence Layer", LIGHT)

# External systems row
sources = ["Jira", "Dynamics 365", "TARA", "PostgreSQL", "Excel/CSV", "Keka"]
dests = ["SharePoint", "TFS", "Holiday Tracker", "Ahrefs", "GSC", "Google Adwords"]
for i, s in enumerate(sources):
    box(ax, 0.5 + i * 1.1, 7.65, 1.0, 0.55, s, fill=ORANGE, fg=NAVY, fontsize=7.5)
for i, d in enumerate(dests):
    box(ax, 7.5 + i * 1.05, 7.65, 0.95, 0.55, d, fill=TEAL, fg=WHITE, fontsize=7.5)

# Frontend row — pages
pages_top = ["Dashboard", "Registry", "Wizard", "Canvas", "Studio", "Monitor"]
pages_bot = ["Alerts", "Vault", "Catalog", "Connected", "Push", "Admin"]
for i, p in enumerate(pages_top):
    box(ax, 0.5 + i * 1.55, 6.3, 1.4, 0.5, p, fill=NAVY, fontsize=8)
for i, p in enumerate(pages_bot):
    box(ax, 0.5 + i * 1.55, 5.65, 1.4, 0.5, p, fill=NAVY, fontsize=8)
# API client
box(ax, 9.7, 5.95, 4.0, 0.55, "services/api.js  (Fetch wrapper)", fill=DEEP, fontsize=9)

# Backend row — API routes
routes = ["/integrations", "/jira", "/sharepoint", "/credentials",
          "/runs", "/sync", "/connected", "/push"]
for i, r in enumerate(routes):
    col = i % 4
    rrow = i // 4
    box(ax, 0.5 + col * 1.85, 3.8 - rrow * 0.55, 1.7, 0.45, r, fill=DEEP, fontsize=8)

# Services
services = ["SyncService", "MapperService", "PushService", "AuthService",
            "Scheduler", "CredentialSvc"]
for i, s in enumerate(services):
    col = i % 3
    rrow = i // 3
    box(ax, 8.2 + col * 1.85, 3.8 - rrow * 0.55, 1.75, 0.45, s, fill=NAVY, fontsize=8)

# Workers strip
box(ax, 0.5, 2.75, 4.6, 0.5, "BullMQ Workers: integration-runner | jira-sp-sync | playwright-sessions",
    fill=ORANGE, fg=NAVY, fontsize=8)
box(ax, 5.3, 2.75, 4.0, 0.5, "Playwright Browser Pool (SSO/MFA)",
    fill=ORANGE, fg=NAVY, fontsize=8)
box(ax, 9.5, 2.75, 4.2, 0.5, "AI Service (Claude API) — Phase 2",
    fill=ORANGE, fg=NAVY, fontsize=8)

# Persistence
box(ax, 0.5, 1.0, 4.5, 1.1,
    "PostgreSQL 16  (Drizzle ORM)\napp.* schema (13 tables) + jira_data.*",
    fill=DEEP, fontsize=9)
box(ax, 5.3, 1.0, 4.0, 1.1,
    "Redis 7  (BullMQ queues)\njobs · schedules · streams",
    fill=DEEP, fontsize=9)
box(ax, 9.5, 1.0, 4.2, 1.1,
    "AES-256-GCM Vault  (logical)\nencryptedPayload column",
    fill=DEEP, fontsize=9)

# Connectors (arrows)
# External → Backend
arrow(ax, 3.0, 7.65, 3.0, 4.30, label="REST / OAuth / Browser", color=NAVY)
arrow(ax, 10.5, 7.65, 10.5, 4.30, label="Graph API / REST", color=NAVY)
# FE → API client → BE
arrow(ax, 11.7, 5.95, 11.7, 4.30, label="HTTP/JSON", color=NAVY)
# BE → DB
arrow(ax, 2.5, 2.75, 2.5, 2.10, color=NAVY)
arrow(ax, 7.0, 2.75, 7.0, 2.10, color=NAVY)
arrow(ax, 11.6, 2.75, 11.6, 2.10, color=NAVY)
# Workers → BE services
arrow(ax, 4.5, 3.25, 4.5, 2.75, color=ORANGE)

plt.tight_layout()
fig.savefig(OUT / "architecture.png", dpi=170, bbox_inches="tight", facecolor=WHITE)
plt.close(fig)
print(f"WROTE: {OUT / 'architecture.png'}")


# ================================================================
# DIAGRAM 2 — MODULE COMMUNICATION (REQUEST FLOW)
# ================================================================
fig, ax = plt.subplots(figsize=(13, 7.5))
ax.set_xlim(0, 14)
ax.set_ylim(0, 9)
ax.axis("off")
ax.set_title("Xn Hub — Module Communication (Request Flow)",
             fontsize=14, weight="bold", color=NAVY, pad=14)

# Lifelines (vertical columns) — sequence-style
columns = [
    ("Operator", 1.2),
    ("React Page", 3.2),
    ("api.js", 5.0),
    ("Express Route", 6.9),
    ("Service Layer", 9.0),
    ("Drizzle / DB", 11.0),
    ("BullMQ Worker", 12.9),
]
for name, x in columns:
    box(ax, x - 0.85, 8.05, 1.7, 0.55, name, fill=NAVY, fontsize=8.5)
    ax.plot([x, x], [0.4, 7.95], color=GREY, ls="--", lw=0.7, alpha=0.55)

# Sequence arrows (top to bottom)
# 1 click
arrow(ax, 1.2, 7.40, 3.2, 7.40, label="1. Click 'Run Now'", color=NAVY)
# 2 fetch
arrow(ax, 3.2, 6.90, 5.0, 6.90, label="2. POST /integrations/:id/run", color=NAVY)
# 3 http
arrow(ax, 5.0, 6.40, 6.9, 6.40, label="3. HTTP", color=NAVY)
# 4 Zod validate then call service
arrow(ax, 6.9, 5.90, 9.0, 5.90, label="4. validate + dispatch", color=NAVY)
# 5 service inserts run row
arrow(ax, 9.0, 5.40, 11.0, 5.40, label="5. INSERT runs (status=pending)", color=NAVY)
# 6 enqueue
arrow(ax, 9.0, 4.90, 12.9, 4.90, label="6. enqueue job", color=ORANGE)
# 7 ack to client
arrow(ax, 6.9, 4.40, 5.0, 4.40, label="7. 202 Accepted { runId }", color=GREY)
arrow(ax, 5.0, 4.10, 3.2, 4.10, color=GREY)
arrow(ax, 3.2, 3.80, 1.2, 3.80, label="8. toast + poll", color=GREY)

# Worker async path (lower band)
band(ax, 0.3, 1.0, 13.4, 2.4, "Async — BullMQ worker picks up the job", ORANGE)

# Worker calls
arrow(ax, 12.9, 3.10, 9.0, 3.10, label="9. Worker → Service.execute()", color=ORANGE)
arrow(ax, 9.0, 2.55, 11.0, 2.55, label="10. UPDATE runs (running)", color=NAVY)
arrow(ax, 9.0, 2.05, 11.0, 2.05, label="11. extract → normalise → push", color=NAVY)
arrow(ax, 9.0, 1.55, 11.0, 1.55, label="12. UPDATE runs + sync_state + jira_item_cache", color=NAVY)
arrow(ax, 11.0, 1.05, 12.9, 1.05, color=ORANGE)
arrow(ax, 12.9, 0.65, 1.2, 0.65, label="13. SSE / poll → page renders 'success'", color=GREY)

plt.tight_layout()
fig.savefig(OUT / "module_flow.png", dpi=170, bbox_inches="tight", facecolor=WHITE)
plt.close(fig)
print(f"WROTE: {OUT / 'module_flow.png'}")


# ================================================================
# DIAGRAM 3 — JIRA → SHAREPOINT DATA FLOW (CURRENT STATE)
# ================================================================
fig, ax = plt.subplots(figsize=(13, 7.5))
ax.set_xlim(0, 14)
ax.set_ylim(0, 9)
ax.axis("off")
ax.set_title("Jira → SharePoint Data Flow  (current end-to-end pipeline)",
             fontsize=14, weight="bold", color=NAVY, pad=14)

# Source side
box(ax, 0.3, 7.2, 2.7, 1.0, "Jira Cloud", fill=ORANGE, fg=NAVY, fontsize=11)
box(ax, 0.3, 5.6, 2.7, 0.9, "Red Gold\nREST API + Basic Auth (token)", fill=NAVY, fontsize=8.5)
box(ax, 0.3, 4.4, 2.7, 0.9, "Flatiron\nPlaywright SSO/MFA + TOTP", fill=NAVY, fontsize=8.5)

# Pipeline middle
box(ax, 3.6, 5.95, 2.5, 0.65, "JiraTicketNormalizer", fill=DEEP, fontsize=9)
box(ax, 3.6, 5.05, 2.5, 0.65, "JiraOutputWriter", fill=DEEP, fontsize=9)
box(ax, 6.6, 5.95, 2.5, 0.65, "SharePointMapperService\n(35-field map)", fill=DEEP, fontsize=8.5)
box(ax, 6.6, 5.05, 2.5, 0.65, "Field Transformer\n(derived fields)", fill=DEEP, fontsize=8.5)
box(ax, 9.6, 5.95, 2.7, 0.65, "SharePointPushService\n(batched 20/req)", fill=DEEP, fontsize=8.5)
box(ax, 9.6, 5.05, 2.7, 0.65, "3-layer dedup", fill=ORANGE, fg=NAVY, fontsize=9)

# Destination
box(ax, 12.6, 6.3, 1.2, 1.6, "SharePoint\nList", fill=TEAL, fg=WHITE, fontsize=10)

# Persistence row (lower)
box(ax, 0.3, 2.9, 2.7, 0.9, "jira_data.jira_tickets\n(raw + normalised)", fill=DEEP, fontsize=8.5)
box(ax, 3.6, 2.9, 2.5, 0.9, "app.runs\n(status, recordsIn/Out, errors)", fill=DEEP, fontsize=8.5)
box(ax, 6.6, 2.9, 2.5, 0.9, "app.jira_item_cache\n(jiraKey ↔ spItemId)", fill=DEEP, fontsize=8.5)
box(ax, 9.6, 2.9, 2.7, 0.9, "app.push_log\n(history + dedup keys)", fill=DEEP, fontsize=8.5)
box(ax, 12.6, 2.9, 1.2, 0.9, "app.sync_state\n(watermarks)", fill=DEEP, fontsize=8.5)

# Sched + alerts band
band(ax, 0.3, 1.0, 13.4, 1.5, "Scheduling, Observability & Alerting", ORANGE)
box(ax, 0.5, 1.2, 3.2, 0.6, "BullMQ cron (SchedulerService)", fill=ORANGE, fg=NAVY, fontsize=8.5)
box(ax, 4.0, 1.2, 3.2, 0.6, "Run logs + sync watermarks", fill=ORANGE, fg=NAVY, fontsize=8.5)
box(ax, 7.5, 1.2, 3.2, 0.6, "Alerts (Phase 2 — pending)", fill=ALTROW, fg=NAVY, fontsize=8.5, bold=False)
box(ax, 11.0, 1.2, 2.8, 0.6, "Health Dashboard (Phase 2)", fill=ALTROW, fg=NAVY, fontsize=8.5, bold=False)

# Arrows top row
arrow(ax, 1.65, 7.20, 1.65, 6.50, color=NAVY)
arrow(ax, 1.65, 5.60, 1.65, 5.30, color=NAVY)
arrow(ax, 3.0, 6.27, 3.6, 6.27, label="extract", color=NAVY)
arrow(ax, 6.1, 6.27, 6.6, 6.27, label="map", color=NAVY)
arrow(ax, 9.1, 6.27, 9.6, 6.27, label="dedup+batch", color=NAVY)
arrow(ax, 12.3, 6.62, 12.6, 6.62, label="Graph API", color=NAVY)

# Persistence connections (vertical down)
arrow(ax, 4.85, 5.05, 4.85, 3.80, color=GREY)
arrow(ax, 7.85, 5.05, 7.85, 3.80, color=GREY)
arrow(ax, 10.95, 5.05, 10.95, 3.80, color=GREY)
arrow(ax, 1.65, 4.40, 1.65, 3.80, color=GREY)
arrow(ax, 13.2, 6.30, 13.2, 3.80, color=GREY)

# Cron triggers worker (lower band into pipeline)
arrow(ax, 2.0, 1.80, 2.0, 5.05, color=ORANGE, style="->", lw=1.5)

# Legend
ax.text(0.3, 0.55, "Solid arrows = current dataflow.  Orange = scheduling / observability.  "
                  "Light boxes = Phase 2 destinations (not yet implemented).",
        fontsize=8.5, color=GREY, style="italic")

plt.tight_layout()
fig.savefig(OUT / "data_flow.png", dpi=170, bbox_inches="tight", facecolor=WHITE)
plt.close(fig)
print(f"WROTE: {OUT / 'data_flow.png'}")
