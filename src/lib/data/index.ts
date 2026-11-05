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
export { listWebhooks, createWebhook, deleteWebhook } from "./webhooks";
export { getFanPass, spin, getSpinAttemptStatus, createPass } from "./spins";
export { setPlayReminder, takeBreak } from "./playGuard";
export {
  editGrant,
  grantSpins,
  listFans,
  getCreatorCrm,
  getFanDetail,
  deleteFan,
  setFanBlocked,
  setFanLinkGame,
  reportCreator,
  selfExclude,
  updateFanMeta,
  ackFan,
} from "./fans";
export {
  createCampaign,
  listCampaigns,
  listActingCampaigns,
  getCampaignStats,
  getUncategorizedStats,
  listCampaignPacks,
  createCampaignPack,
  updateCampaignPack,
  deleteCampaignPack,
  setCampaignPinnedWheel,
  renameCampaign,
  setCampaignActive,
  deleteCampaign,
} from "./campaigns";
export { reportPublicPhoto } from "./publicReports";
export {
  listDmTemplates,
  createDmTemplate,
  deleteDmTemplate,
  sendFanMessage,
  getFanMessages,
  listThreads,
  hasThreadWith,
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
  leaveOrg,
  getMyInvites,
  updateAccount,
  createCreatorAccount,
  getMyApprovalStatus,
  submitCreatorApplication,
  listCreatorApplications,
  decideCreatorApplication,
} from "./admin";
export type { OrgRole } from "./admin";
export {
  clearMyData,
  getOnboardingDismissed,
  setOnboardingDismissed,
  getMyAccount,
  setMyDisplayName,
  setMyNotificationPrefs,
  setActiveWheelBrandColor,
} from "./account";
export {
  getPublicWheelTeaser,
  getPublicProfileBySlug,
  getMyPublicProfile,
  normalizePublicSlug,
  setMyPublicProfile,
} from "./publicProfile";
export { getNotifications, markNotificationsSeen } from "./notifications";
export { getFanAppInfo, getMyPwaIconMode, setMyPwaIconMode } from "./pwa";
export { recordCheckin } from "./checkins";
export { recordOutreach, ageFanActivityForDemo } from "./outreach";
export { recordAudit, listAuditLog } from "./audit";
export { exportFanData, deleteFanData, getFanLinkStatus, exportCreatorData, isPlausibleToken } from "./privacy";
export type { FanLinkStatus } from "./privacy";
export { getMyTermsStatus, acceptMyTerms } from "./terms";

export {
  getPushConfig,
  pushAccountId,
  listMyPushDevices,
  addMyPushSubscription,
  removeMyPushDevice,
  setMyPushDeviceDetails,
  sendMyTestPush,
} from "./push";

export { getPrizeDelivery, setPrizeDelivery, addPrizeCodes, getFanReward, getFanRewardHistory, isShareIdShape } from "./rewards";
export { getCreatorThemeView, getMyTheme, setMyTheme, addMyMedia, setMyMediaCaption, reorderMyMedia, deleteMyMedia, adminRemoveCreatorMedia } from "./creatorTheme";

export { getFanFocusState, getCreatorFocus, grantFocusPack, cancelFanFocus } from "./focus";
