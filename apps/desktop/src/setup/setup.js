/* global document, window */

// Script of the bundled setup page. It only talks to `window.tadooerSetup`,
// the three calls exposed by setup-preload; the main process does the
// validation and the request to the server.

const setup = window.tadooerSetup;
const form = document.querySelector("#setup-form");
const address = document.querySelector("#address");
const lan = document.querySelector("#lan");
const allowLan = document.querySelector("#allow-lan");
const message = document.querySelector("#message");
const connect = document.querySelector("#connect");
const cancel = document.querySelector("#cancel");

const say = (text, kind) => {
  message.textContent = text;
  message.dataset.kind = kind;
};

const start = async () => {
  const state = await setup.state();
  if (typeof state.currentOrigin === "string") {
    address.value = state.currentOrigin;
    cancel.hidden = false;
  }
  address.focus();
  document.documentElement.dataset.ready = "true";
};

address.addEventListener("input", () => {
  // A new address needs a new decision about plaintext HTTP.
  lan.hidden = true;
  allowLan.checked = false;
  say("", "info");
});

cancel.addEventListener("click", () => {
  void setup.cancel();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  connect.disabled = true;
  say("Checking the server", "info");
  void setup
    .connect(address.value, !lan.hidden && allowLan.checked)
    .then((result) => {
      if (result.ok) {
        say(`Connected to Tadooer ${result.version}`, "info");
        return;
      }
      if (result.reason === "private-lan-consent") lan.hidden = false;
      say(result.message, "error");
    })
    .catch(() => {
      say("The check could not be completed.", "error");
    })
    .finally(() => {
      connect.disabled = false;
    });
});

void start();
