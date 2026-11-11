/* Shareable links. The URL hash keeps the tab, the network conditions, the
   seed, and the inputs marked with data-share in that tab. */

import { $, controls, showConditionValues } from "./core.js";

const CONDITION_KEYS = {
  d: "delay",
  j: "jitter",
  l: "loss",
  bw: "bandwidth",
  b: "burst",
  dup: "duplicate",
  q: "queue",
  rd: "reverseDelay",
};

function shareInputs(tab) {
  return [...document.querySelectorAll(`#panel-${tab} [data-share]`)];
}

function readInput(node) {
  if (node.tagName === "FIELDSET") {
    return [...node.querySelectorAll("input:checked")].map((box) => box.value).join(",");
  }
  if (node.type === "checkbox") return node.checked ? "1" : "0";
  return node.value;
}

function writeInput(node, value) {
  if (node.tagName === "FIELDSET") {
    const chosen = new Set(value.split(","));
    for (const box of node.querySelectorAll("input[type=checkbox]")) box.checked = chosen.has(box.value);
  } else if (node.type === "checkbox") {
    node.checked = value === "1";
  } else if (node.tagName === "SELECT") {
    if ([...node.options].some((option) => option.value === value)) node.value = value;
  } else {
    node.value = value.slice(0, Number(node.maxLength) > 0 ? node.maxLength : 2000);
  }
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

// shareURL returns a link that opens this tab with the same run.
export function shareURL(tab) {
  const params = new URLSearchParams({ tab });
  for (const [key, name] of Object.entries(CONDITION_KEYS)) {
    if (name === "reverseDelay" && !controls.asymmetric.checked) continue;
    params.set(key, controls[name].value);
  }
  params.set("seed", controls.seed.value);
  for (const node of shareInputs(tab)) params.set(node.id, readInput(node));
  return `${location.origin}${location.pathname}#${params}`;
}

export function rememberRun(tab) {
  history.replaceState(null, "", shareURL(tab));
}

// applySharedLink reads the hash. It returns the tab name, or null.
export function applySharedLink(validTabs) {
  const params = new URLSearchParams(location.hash.slice(1));
  const tab = params.get("tab");
  if (!tab || !validTabs.includes(tab)) return null;

  controls.preset.value = "custom";
  for (const [key, name] of Object.entries(CONDITION_KEYS)) {
    const value = params.get(key);
    if (value === null) continue;
    if (controls[name].tagName === "SELECT") {
      if ([...controls[name].options].some((option) => option.value === value)) controls[name].value = value;
    } else if (Number.isFinite(Number(value))) {
      controls[name].value = value;
    }
  }
  controls.asymmetric.checked = params.has("rd");
  if (params.has("rd") || params.has("b") || params.has("dup") || params.has("q")) {
    const advanced = params.get("b") !== "0" || params.get("dup") !== "0" || params.get("q") !== "0" || params.has("rd");
    if (advanced) {
      $("#more-conditions").setAttribute("aria-expanded", "true");
      $("#advanced-conditions").hidden = false;
    }
  }
  const seed = Number(params.get("seed"));
  if (Number.isInteger(seed) && seed > 0) {
    controls.seed.value = String(seed);
    controls.lockSeed.checked = true;
  }
  showConditionValues();

  for (const node of shareInputs(tab)) {
    const value = params.get(node.id);
    if (value !== null) writeInput(node, value);
  }
  return tab;
}

export function setupShareButton(currentTab, onCopied) {
  $("#share").addEventListener("click", async () => {
    const url = shareURL(currentTab());
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      onCopied("Link copied. It opens this tab with the same network and seed.");
    } catch {
      window.prompt("Copy this link:", url);
    }
  });
}
