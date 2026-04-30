export function renderTabs(tabs, target) {
  target.innerHTML = tabs.map((tab) => `<li>${tab}</li>`).join('');
}
