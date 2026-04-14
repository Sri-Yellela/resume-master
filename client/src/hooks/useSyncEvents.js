import { useEffect, useRef } from "react";

/**
 * useSyncEvents — subscribes to /api/sync/events (SSE) and dispatches
 * incoming events to the provided handler map.
 *
 * handlers: { [eventType]: (payload) => void }
 *   Supported types: job_flag, resume_generated, profile_switched, scrape_complete
 *
 * The EventSource reconnects automatically on network failure.
 * The connection is closed when the component unmounts.
 */
export function useSyncEvents(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let es;
    let retryTimeout;
    let closed = false;

    function connect() {
      if (closed) return;
      es = new EventSource("/api/sync/events", { withCredentials: true });

      es.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          const { type, ...rest } = payload;
          if (type === "heartbeat" || type === "connected") return;
          const handler = handlersRef.current?.[type];
          if (typeof handler === "function") handler(rest);
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        es.close();
        if (!closed) {
          retryTimeout = setTimeout(connect, 5000);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, []);
}
