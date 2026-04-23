const STORAGE_KEY = "rmExtensionState";
const popupRoot = document.getElementById("popup");

function actionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", onClick);
  return button;
}

async function sendMessage(payload) {
  return chrome.runtime.sendMessage(payload);
}

function render(state) {
  popupRoot.innerHTML = "";
  const title = document.createElement("h1");
  title.textContent = "Resume Master";
  const message = document.createElement("p");
  const actions = document.createElement("div");
  actions.className = "actions";

  if (state.status === "READY") {
    message.textContent = `Connected as ${state.userEmail || "your account"}. Click Import on the job board to import jobs.`;
  } else if (state.status === "IMPORTING") {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    popupRoot.append(title, spinner);
    message.textContent = "Importing jobs from LinkedIn...";
  } else if (state.status === "DONE") {
    message.textContent = `Imported ${state.importedCount || 0} jobs successfully.`;
    actions.append(
      actionButton("Go to Job Board", "", () => sendMessage({ type: "OPEN_APP" })),
      actionButton("Open Resume Master", "secondary", () => sendMessage({ type: "OPEN_APP" }))
    );
  } else if (state.status === "ERROR") {
    message.textContent = `Import failed: ${state.error || "Unknown error."}`;
    actions.append(
      actionButton("Retry", "", () => sendMessage({ type: "RETRY_IMPORT" })),
      actionButton("Open Resume Master", "secondary", () => sendMessage({ type: "OPEN_APP" }))
    );
  } else {
    message.textContent = "Not connected to Resume Master. Please log in.";
    actions.append(actionButton("Open Resume Master", "", () => sendMessage({ type: "OPEN_APP" })));
  }

  popupRoot.append(title, message, actions);
}

async function loadState() {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  render(stored[STORAGE_KEY] || { status: "NOT_AUTHED" });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !changes[STORAGE_KEY]) return;
  render(changes[STORAGE_KEY].newValue || { status: "NOT_AUTHED" });
});

loadState();
