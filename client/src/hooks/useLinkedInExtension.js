import { useCallback, useEffect, useState } from "react";
import {
  isLinkedInExtensionInstalled,
  sendExtensionRequest,
  subscribeToExtensionEvents,
} from "../lib/extensionBridge.js";

const DEFAULT_STATUS = {
  installed: false,
  status: "NOT_INSTALLED",
  userEmail: null,
  importedCount: 0,
  error: "",
  linkedInTabId: null,
};

export function useLinkedInExtension() {
  const [state, setState] = useState(DEFAULT_STATUS);

  const refresh = useCallback(async () => {
    if (!isLinkedInExtensionInstalled()) {
      setState(DEFAULT_STATUS);
      return DEFAULT_STATUS;
    }
    const response = await sendExtensionRequest({ type: "GET_STATUS" });
    const next = { installed: true, ...(response.state || response) };
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch(() => setState(DEFAULT_STATUS));
    return subscribeToExtensionEvents((payload) => {
      if (payload.type === "EXTENSION_STATUS" && payload.state) {
        setState({ installed: true, ...payload.state });
      }
      if (payload.type === "IMPORT_DONE") {
        setState((prev) => ({
          ...prev,
          installed: true,
          status: "DONE",
          importedCount: payload.count || 0,
          linkedInTabId: payload.tabId || prev.linkedInTabId,
          error: "",
        }));
      }
      if (payload.type === "IMPORT_ERROR") {
        setState((prev) => ({
          ...prev,
          installed: true,
          status: "ERROR",
          linkedInTabId: payload.tabId || prev.linkedInTabId,
          error: payload.error || "Import failed.",
        }));
      }
      if (payload.type === "LINKEDIN_LOGIN_REQUIRED") {
        setState((prev) => ({
          ...prev,
          installed: true,
          status: "READY",
          linkedInTabId: payload.tabId || prev.linkedInTabId,
          error: "",
        }));
      }
    });
  }, [refresh]);

  return {
    extensionState: state,
    refreshExtensionState: refresh,
    extensionInstalled: isLinkedInExtensionInstalled(),
  };
}
