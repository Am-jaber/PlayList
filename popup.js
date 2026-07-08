// Persists the enabled/disabled toggle and reflects it in the UI.
const toggle = document.getElementById("toggle");

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  toggle.checked = enabled;
});

toggle.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: toggle.checked });
});
