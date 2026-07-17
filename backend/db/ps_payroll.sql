-- Payroll snapshots for peer caseload pay periods.
--
-- Finalizing freezes the computed rows into `rows`/`totals` rather than
-- recomputing them on read. Editing an assignment date later must never
-- silently change a report already sent to billing, so a finalized snapshot is
-- the record of what was submitted -- the live periods table is only the
-- record of what is true now. The two are allowed to disagree, and the UI
-- surfaces the drift instead of hiding it.

create table if not exists ps_payroll_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  supervisor_airtable_id text not null,

  period_index       int  not null,   -- 0 = anchor period (2026-06-15..06-28)
  period_start       date not null,
  period_end         date not null,
  pay_date           date not null,

  rows               jsonb not null,  -- frozen per-peer lines at finalize time
  totals             jsonb not null,  -- { peers, peer_days, total_cents, total }

  finalized_at       timestamptz not null default now(),
  finalized_by       text,

  sent_to_billing_at timestamptz,
  paid               boolean not null default false,
  paid_at            timestamptz,
  paid_note          text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One snapshot per period per supervisor; re-finalizing replaces it explicitly.
create unique index if not exists ps_payroll_period_uniq
  on ps_payroll_snapshots (supervisor_airtable_id, period_start);

create index if not exists ps_payroll_paydate_idx
  on ps_payroll_snapshots (supervisor_airtable_id, pay_date desc);
