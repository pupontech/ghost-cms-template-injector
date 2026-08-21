import { createBackground } from './background';

const deps = {
  addOnInstalledListener: (cb: (details: { reason: string }) => void) => {
    chrome.runtime.onInstalled.addListener(cb);
  },
};

createBackground(deps).init();
