/* The Throat sign-in page script. Signed Maridizzle */
(() => {
"use strict";
const f = document.getElementById("lf"), err = document.getElementById("lerr"), btn = document.getElementById("lb");
const nameIn = document.getElementById("ln"), passIn = document.getElementById("lp");

// Already signed in? Go straight to the map.
fetch("/api/me", { headers: { Accept: "application/json" } }).then((r) => { if (r.ok) location.replace("/"); }).catch(() => {});

f.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.textContent = "";
  btn.disabled = true;
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: nameIn.value, password: passIn.value }),
    });
    if (r.ok) { location.replace("/"); return; }
    err.textContent = r.status === 429 ? "Too many tries. Please wait a few minutes."
      : r.status === 401 ? "That name and password do not match."
      : "Something went wrong. Please try again.";
  } catch (x) {
    err.textContent = "Could not reach the server. Check your connection.";
  }
  btn.disabled = false;
  passIn.select();
});
})();
