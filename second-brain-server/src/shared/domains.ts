import type { Domain, ItemStatus } from "./types.js";

export const DOMAINS: Domain[] = [
  "projects",
  "people",
  "ideas",
  "admin",
  "ai_best_practices",
];

export const ITEM_STATUSES: ItemStatus[] = [
  "active",
  "on_hold",
  "completed",
  "archived",
];

export const CONFIDENCE_THRESHOLD = 0.6;

export const MAX_NOTIFICATIONS_PER_DAY = 10;

export const DAILY_BRIEF_MAX_WORDS = 150;
export const WEEKLY_BRIEF_MAX_WORDS = 250;
export const NATE_JONES_HIGHLIGHT_WORDS = 150;

export const NATE_JONES_RSS =
  "https://natesnewsletter.substack.com/feed";
export const NATE_JONES_YOUTUBE_RSS =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCl-p6xh3p9V6sHWU6EbrRrg";
