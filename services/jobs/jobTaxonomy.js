// Single source of truth for role families (Taxonomy B + sales).
// Owns SIGNALS and ROLE_FAMILIES; classification functions live in
// services/jobClassifier.js for now and will move here in a later phase.

export {
  SIGNALS,
  ROLE_TITLE_SQL,
  INGEST_CONFIDENCE_THRESHOLD,
  classifyTitle,
  classifyForIngest,
  getRoleKeyForProfile,
  getRoleFamilyDomainForKey,
  roleTitleSql,
} from '../jobClassifier.js';

// Derived at import time from SIGNALS so the two stay in sync automatically.
import { SIGNALS } from '../jobClassifier.js';
export const ROLE_FAMILIES = Object.keys(SIGNALS);
