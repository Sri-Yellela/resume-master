// ⛔ draft A188 · imported FIRST by server.js, so a staging deploy that carries a production credential exits before any
// module reads it (src/stagingGuard.js).
import { applyStagingGuard } from "./stagingGuard.js";

applyStagingGuard();
