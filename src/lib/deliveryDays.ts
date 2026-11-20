// PR-10: the creator's delivery promise ("I usually deliver within N days").
// Shared by the Settings editor, the public-profile route and the data layer,
// so it must stay free of server-only imports.
export const MAX_DELIVERY_DAYS = 60;
