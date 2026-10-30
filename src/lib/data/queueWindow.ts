// Isomorphic: how many of the newest wins the dashboard overview carries
// (getOverview / mockGetOverview read the newest 200). PrizesPanel reads older
// wins page by page from GET /api/redemptions once the window is full (A5).
export const OVERVIEW_REDEMPTION_WINDOW = 200;
