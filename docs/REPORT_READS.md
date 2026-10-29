# Complete report reads

Reports distinguish paid primary plays from Bingo bonus awards. Paid-play,
engagement and reminder counts exclude bonuses; real prize costs, fulfilment,
reward distributions and rare wins include them. Grants remain the source of
revenue and purchased credits.

`src/lib/data/readPages.ts` reads stable ascending ID pages under one fixed
`created_at` cutoff. Exact remaining counts detect server row caps below the
requested page size. If count metadata is absent, it continues until an empty
page. Financial costs can be aggregated a page at a time. Lists and distinct-ID
sets have explicit bounds.

Defaults are `READ_PAGE_SIZE=500`, `MAX_REPORT_ROWS=50_000` per data source and
`MAX_REPORT_PAGES=128`. A backend error, malformed/non-advancing page or exhausted
budget fails the whole report. Its API returns503 with
`{error:"data_unavailable",dataStatus:"unavailable"}` and no partial amounts.
A fully read report may still have unknown prize costs; that separate condition
keeps `costsComplete=false`.

Costs are joined by the awarded prize's ID, never its display label. Distinct
prizes sharing a name remain separate ROI rows, and renaming a prize does not
reassign its wins. Deleted/NULL, unresolved or out-of-scope prize references
remain unknown rather than borrowing a surviving same-name prize's cost.

No immutable cost-at-award snapshot is stored. These reports explicitly expose
`costBasis:"current_prize_cost"` and `historicalCostsKnown:false`; changing a
current prize cost changes the estimate. `costsComplete` means every included
award has a known current-cost estimate, not that historical realized profit is
known. With unknown costs, the returned known-cost arithmetic gives a lower-bound
cost and upper-bound profit; the UI hides complete cost/profit/margin estimates.
A future historical-cost feature needs a private,
transactionally captured record; creator costs must not enter public fairness
snapshots.

The cutoff prevents later inserts shifting the history read. It is not a
transaction snapshot of mutable account balances, fulfilment states or current
prize prices. A report requiring more than these bounds needs a narrower window
or a separately authorized aggregate/paged-history design; do not turn partial
amounts into complete totals. The200-row overview fulfilment list and20-row public
recent-win feed remain intentional display limits, backed by complete counts or
complete bounded aggregation.
