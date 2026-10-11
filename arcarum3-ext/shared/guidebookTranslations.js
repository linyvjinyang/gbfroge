import { normalizeGuidebookText } from "./guidebooks.js";
import { translateCharacterGuidebook } from "./characterGuidebooks.js";

// Kept for compatibility with older hand-edited installations.
export const GUIDEBOOK_TRANSLATIONS = Object.freeze({});

export function getGuidebookDisplayName(entry) {
  return (
    normalizeGuidebookText(entry?.text?.["zh-CN"]) ||
    normalizeGuidebookText(GUIDEBOOK_TRANSLATIONS[String(entry?.statusId)]) ||
    // 角色专属导本：编号未知时按原文格式给出翻译
    translateCharacterGuidebook(entry?.text?.ja || entry?.rawName) ||
    normalizeGuidebookText(entry?.rawName) ||
    normalizeGuidebookText(entry?.text?.ja) ||
    normalizeGuidebookText(entry?.text?.en) ||
    `未知导本 #${entry?.statusId ?? "?"}`
  );
}
