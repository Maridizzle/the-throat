/* Supplemental accessibility for The Throat. No map data or network access. */
(() => {
  "use strict";
  const map = document.getElementById("c");
  if (!map || document.documentElement.dataset.throatAccessibility === "ready") return;
  document.documentElement.dataset.throatAccessibility = "ready";

  const focusSelector = [
    "a[href]", "area[href]", "button", "input:not([type='hidden'])",
    "select", "textarea", "summary", "[contenteditable='true']", "[tabindex]"
  ].join(",");
  function available(node) {
    if (!(node instanceof HTMLElement) || !node.isConnected ||
        node.matches(":disabled") || node.closest("[hidden],[inert]")) return false;
    const style = getComputedStyle(node);
    return style.visibility !== "hidden" && style.visibility !== "collapse" &&
      style.display !== "none" && node.getClientRects().length > 0;
  }
  function focus(node) {
    if (!available(node)) return false;
    try { node.focus({ preventScroll: true }); } catch (_) { node.focus(); }
    return document.activeElement === node;
  }
  function tabStops(root) {
    return Array.from(root.querySelectorAll(focusSelector))
      .filter((node) => available(node) && node.tabIndex >= 0);
  }

  // A semantic map landmark keeps the canvas and its textual instructions together.
  if (!document.querySelector("main,[role='main']") && map.parentElement === document.body) {
    const main = document.createElement("main");
    main.id = "map-space";
    main.setAttribute("aria-label", "Story map");
    document.body.insertBefore(main, map);
    main.append(map);
    const labels = document.getElementById("labels");
    if (labels) main.append(labels);
  }
  const style = document.createElement("style");
  style.textContent =
    "#c:focus-visible{outline:3px solid #E6DDF3;outline-offset:-6px}" +
    ".throat-a11y-description{position:absolute!important;width:1px;height:1px;" +
    "padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);" +
    "white-space:nowrap;border:0}";
  document.head.append(style);
  const help = document.createElement("p");
  help.id = "throatMapKeyboardHelp";
  help.className = "throat-a11y-description";
  help.textContent = "When the story map has focus, W and S glide, A and D turn, " +
    "and plus and minus zoom. Use the Story time selector and Previous or Next " +
    "controls to browse nodes in story order. To select a node by name, use Layers: " +
    "expand a layer and activate a named node. Node details provides its story " +
    "time and connected nodes. Reset view returns to the overview.";
  map.parentElement.append(help);
  function describe(node, id) {
    if (!node) return;
    const ids = new Set((node.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(id);
    node.setAttribute("aria-describedby", Array.from(ids).join(" "));
  }
  map.tabIndex = 0;
  map.setAttribute("role", "img");
  describe(map, help.id);
  const timeline = document.getElementById("st");
  if (timeline) {
    timeline.setAttribute("role", "img");
    describe(timeline, help.id);
  }
  [
    ["legend", "Layers"], ["detail", "Node details"],
    ["controls", "Map controls"], ["strip", "Story timeline"],
    ["mini", "Map overview"]
  ].forEach(([id, name]) => {
    const node = document.getElementById(id);
    if (node) {
      node.setAttribute("role", "region");
      node.setAttribute("aria-label", name);
    }
  });
  const overview = document.getElementById("mm");
  if (overview) {
    overview.setAttribute("role", "img");
    overview.setAttribute("aria-label", "Overview of the story map");
  }
  let pointerFocus = false;
  map.addEventListener("focus", () => {
    if (!pointerFocus) document.getElementById("map-space")?.scrollIntoView({
      block: "center", inline: "nearest", behavior: "auto"
    });
  });
  map.addEventListener("pointerdown", () => {
    if (!document.querySelector(".modal")) {
      pointerFocus = true;
      try { focus(map); } finally { pointerFocus = false; }
    }
  });
  // W/A/S/D remain in app.js and are scoped there to this focused canvas.
  map.addEventListener("keydown", (event) => {
    if (document.activeElement !== map || document.querySelector(".modal") ||
        event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      map.dispatchEvent(new WheelEvent("wheel", {
        deltaY: event.key === "-" ? 140 : -140, bubbles: true, cancelable: true
      }));
    }
  });

  let session = null;
  let lastOutsideModal = document.activeElement;
  let lastOutsideChat = document.activeElement;
  let chatLauncher = null;
  const inertBefore = new Map();
  const modalObserver = new MutationObserver(() => syncModal());

  function firstModalFocus() {
    if (!session) return;
    const stops = tabStops(session.box);
    if (stops.length) { focus(stops[0]); return; }
    if (!session.box.hasAttribute("tabindex")) session.box.tabIndex = -1;
    focus(session.box);
  }
  function fallbackFocus(preferred) {
    if (focus(preferred)) return;
    const chat = document.getElementById("chat");
    if (chat && !chat.hidden && focus(document.getElementById("chatIn"))) return;
    if (focus(document.getElementById("chatBtn"))) return;
    focus(map);
  }
  function syncModal() {
    const modal = document.querySelector(".modal");
    if (modal) {
      const box = modal.querySelector("[role='dialog']") || modal;
      if (!session || session.modal !== modal) {
        const returnTo = session ? session.returnTo : lastOutsideModal;
        modalObserver.disconnect();
        session = { modal, box, returnTo };
        modalObserver.observe(modal, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["hidden", "disabled", "tabindex", "style", "class"]
        });
      }
      Array.from(document.body.children).forEach((node) => {
        if (node === modal || node.contains(modal)) return;
        if (!inertBefore.has(node)) inertBefore.set(node, node.hasAttribute("inert"));
        if (!node.hasAttribute("inert")) node.setAttribute("inert", "");
      });
      if (!box.contains(document.activeElement)) firstModalFocus();
      return;
    }
    if (!session) return;
    const returnTo = session.returnTo;
    session = null;
    modalObserver.disconnect();
    inertBefore.forEach((wasInert, node) => {
      if (wasInert) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
    });
    inertBefore.clear();
    fallbackFocus(returnTo);
  }

  const chat = document.getElementById("chat");
  let chatWasOpen = !!chat && !chat.hidden;
  function syncChat() {
    if (!chat) return;
    const open = !chat.hidden;
    const button = document.getElementById("chatBtn");
    if (button) {
      button.setAttribute("aria-controls", "chat");
      button.setAttribute("aria-expanded", String(open));
    }
    const wasOpen = chatWasOpen;
    chatWasOpen = open;
    if (open && !wasOpen) chatLauncher = lastOutsideChat;
    else if (!open && wasOpen && !document.querySelector(".modal")) {
      if (!focus(chatLauncher)) focus(button);
    }
  }
  document.addEventListener("focusin", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLElement)) return;
    const inModal = node.closest(".modal");
    if (inModal) syncModal();
    else if (session && document.querySelector(".modal")) {
      firstModalFocus();
      return;
    } else lastOutsideModal = node;
    syncChat();
    if (!chat || !chat.contains(node)) lastOutsideChat = node;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    syncModal();
    if (!session) return;
    const stops = tabStops(session.box);
    if (!stops.length) { event.preventDefault(); firstModalFocus(); return; }
    const first = stops[0], last = stops[stops.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !stops.includes(active))) {
      event.preventDefault(); focus(last);
    } else if (!event.shiftKey && (active === last || !stops.includes(active))) {
      event.preventDefault(); focus(first);
    }
  }, true);
  new MutationObserver(() => syncModal()).observe(document.body, { childList: true });
  if (chat) new MutationObserver(() => syncChat()).observe(chat, {
    attributes: true, attributeFilter: ["hidden"]
  });
  syncChat();
  syncModal();

  // Startup remains app.js's decision; react only when the OS changes to reduce.
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const motionChanged = (event) => {
    if (!event.matches) return;
    const calm = document.getElementById("calm");
    if (calm && !calm.checked) {
      calm.checked = true;
      calm.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  if (motion.addEventListener) motion.addEventListener("change", motionChanged);
  else if (motion.addListener) motion.addListener(motionChanged);
})();
