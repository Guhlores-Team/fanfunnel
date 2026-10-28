// Data layer barrel. Every function lives in a domain module next to this
// file; this re-exports the public surface so `@/lib/data` keeps working.
// Internal helpers (row shapes, resolvers) are deliberately NOT re-exported.
//   ./shared.ts
//   ./wheels.ts
//   ./webhooks.ts
//   ./spins.ts
//   ./fans.ts
//   ./campaigns.ts
//   ./inbox.ts
//   ./templates.ts
//   ./analytics.ts
//   ./fulfilment.ts
//   ./boosts.ts
//   ./referrals.ts
//   ./admin.ts
//   ./account.ts
//   ./publicProfile.ts
//   ./playGuard.ts

export type { FanPassView, SpinError } from "./shared";
export {
  getWheel,
  saveWheel,
  prizeRow,
  getWheelById,
  listWheels,
  createWheel,
  duplicateWheel,
  archiveWheel,
  unarchiveWheel,
  deleteWheel,
  setActiveWheel,
  setWheelSchedule,
} from "./wheels";
export { listWebhooks, createWebhook, deleteWebhook, fireWebhooks } from "./webhooks";
export { getFanPass, spin, completeClaimedSpin, createPass } from "./spins";
export { setPlayReminder, takeBreak } from "./playGuard";
export {
  editGrant,
  grantSpins,
  listFans,
  getCreatorCrm,
  getFanDetail,
  deleteFan,
  setFanBlocked,
  reportCreator,
  selfExclude,
  updateFanMeta,
  ackFan,
} from "./fans";
export type { CrmFan, CreatorCrm } from "./fans";
export {
  createCampaign,
  listCampaigns,
  getCampaignStats,
  getUncategorizedStats,
  listCampaignPacks,
  createCampaignPack,
  updateCampaignPack,
  deleteCampaignPack,
  setCampaignPinnedWheel,
  renameCampaign,
  deleteCampaign,
} from "./campaigns";
export type { UncategorizedStats } from "./campaigns";
export {
  listDmTemplates,
  createDmTemplate,
  deleteDmTemplate,
  sendFanMessage,
  getFanMessages,
  listThreads,
  getThread,
  sendCreatorMessage,
  getChatSettings,
  setChatSettings,
  ensureChatIntro,
  sendChatOutro,
} from "./inbox";
export {
  listPrizeTemplates,
  createPrizeTemplate,
  deletePrizeTemplate,
  listWheelTemplates,
  createWheelTemplate,
  deleteWheelTemplate,
} from "./templates";
export {
  getOverview,
  getMetricsExtra,
  getEngagementHeatmap,
  getPrizeRoi,
  getProfitSummary,
  getCohortRetention,
  getAutopilot,
  dismissAutopilotCard,
} from "./analytics";
export type { ProfitSummary, AutopilotAction, AutopilotCard } from "./analytics";
export { setRedemptionStatus, setRedemptionMeta } from "./fulfilment";
export {
  listHappyHours,
  createHappyHour,
  deleteHappyHour,
  getShareCard,
  getSpinVerification,
  addWishlist,
  removeWishlist,
  getWishlistDemand,
  setLeaderboardEnabled,
  setFanLeaderboardOptIn,
  getLeaderboard,
  getRecentWins,
} from "./boosts";
export type { RecentWin } from "./boosts";
export { getReferralStats } from "./referrals";
export {
  isCurrentUserAdmin,
  claimAdmin,
  getAdminOverview,
  getAgencyOverview,
  createOrg,
  inviteOrgCreator,
  revokeOrgInvite,
  respondToOrgInvite,
  removeOrgCreator,
  addOrgMember,
  removeOrgMember,
  scopeOrgCreator,
  getMyInvites,
  updateAccount,
  createCreatorAccount,
  getMyApprovalStatus,
  submitCreatorApplication,
  listCreatorApplications,
  decideCreatorApplication,
} from "./admin";
export type {
  OrgRole,
  OrgCreatorStat,
  OrgMember,
  PendingInvite,
  AgencyOverview,
  MyInvite,
  ApprovalStatus,
  CreatorApplication,
} from "./admin";
export {
  clearMyData,
  getOnboardingDismissed,
  setOnboardingDismissed,
  getMyAccount,
  setMyDisplayName,
  setMyNotificationPrefs,
  setActiveWheelBrandColor,
} from "./account";
export type { NotificationPrefs, MyAccount } from "./account";
export {
  getPublicWheelTeaser,
  getPublicProfileBySlug,
  getMyPublicProfile,
  normalizePublicSlug,
  setMyPublicProfile,
} from "./publicProfile";
export type { PublicProfile } from "./publicProfile";
export { getNotifications, markNotificationsSeen } from "./notifications";
export type { NotificationFeed, NotificationItem, NotificationKind, NotificationTarget } from "./notifications";
export { getFanAppInfo, getMyPwaIconMode, setMyPwaIconMode } from "./pwa";
export { recordCheckin } from "./checkins";
export { recordOutreach, ageFanActivityForDemo } from "./outreach";
export { recordAudit, listAuditLog } from "./audit";
export type { AuditAction, AuditEntry, AuditInput } from "./audit";
export { exportFanData, deleteFanData, getFanLinkStatus, exportCreatorData, isPlausibleToken } from "./privacy";
export type { FanLinkStatus } from "./privacy";
export { getMyTermsStatus, acceptMyTerms } from "./terms";
export type { TermsStatus } from "./terms";
