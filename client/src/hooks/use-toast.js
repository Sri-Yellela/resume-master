// Simplified use-toast hook (no TypeScript)
import { useState, useCallback } from "react";

let listeners = [];
let toastState = { toasts: [] };
let toastCounter = 0;

function dispatch(action) {
  switch (action.type) {
    case "ADD_TOAST":
      toastState = { toasts: [action.toast, ...toastState.toasts].slice(0, 5) };
      break;
    case "DISMISS_TOAST":
      toastState = {
        toasts: toastState.toasts.map(t =>
          t.id === action.toastId || action.toastId === undefined
            ? { ...t, open: false }
            : t
        ),
      };
      break;
    case "REMOVE_TOAST":
      toastState = {
        toasts: toastState.toasts.filter(t => t.id !== action.toastId),
      };
      break;
  }
  listeners.forEach(listener => listener(toastState));
}

export function toast({ ...props }) {
  const id = String(++toastCounter);

  const update = (p) => dispatch({ type: "ADD_TOAST", toast: { ...p, id } });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return { id, dismiss, update };
}

export function useToast() {
  const [state, setState] = useState(toastState);

  const subscribe = useCallback((listener) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  }, []);

  useState(() => {
    const unsubscribe = subscribe(setState);
    return unsubscribe;
  });

  return {
    ...state,
    toast,
    dismiss: (toastId) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}
