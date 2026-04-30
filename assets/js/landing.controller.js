import { landingModel } from './landing.model.js';
import { renderTabs } from './landing.view.js';

function initLandingPage() {
  const tabsList = document.querySelector('#tabs-list');
  if (!tabsList) return;
  renderTabs(landingModel.tabs, tabsList);
}

document.addEventListener('DOMContentLoaded', initLandingPage);
