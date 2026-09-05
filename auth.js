/* Shared sign-in gate for everything under matsumotojay.github.io/hq/
   ------------------------------------------------------------------
   Why this exists: the old Firestore rule was `allow read, write: if
   request.auth != null`, and anonymous sign-in is enabled on this project.
   Every visitor's browser silently got a token just by loading a page, so
   that rule let anyone read AND write Jay's income, invoices, client phone
   numbers and Hikaru's address. This gate replaces the anonymous session
   with a named one so the rules have something real to check.

   Passwordless on purpose. Jay's requirement was "I don't want to log in
   every time and remember a password." So: you type your email once, click
   the link that arrives, and Firebase's browserLocalPersistence keeps you
   signed in on that device indefinitely. Same for Hikaru and Ayuko.

   Auth persistence is per-ORIGIN, so one sign-in covers the tracker, the
   wedding board and the artist database — they all live on this domain.  */

const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
const EMAIL_KEY = "hq.signin.email";

export async function requireAuth(FBCONFIG, opts = {}) {
  const label = opts.label || "this page";

  const [{ initializeApp, getApps, getApp }, authMod] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
  ]);
  const {
    getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
    sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
  } = authMod;

  const app = getApps().length ? getApp() : initializeApp(FBCONFIG);
  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);

  /* Returning from the emailed link. The address is normally still in
     localStorage from when the link was requested; if the link is opened on a
     DIFFERENT device than it was requested from, that's empty and Firebase
     requires us to ask again — hence the prompt fallback. */
  if (isSignInWithEmailLink(auth, location.href)) {
    let email = localStorage.getItem(EMAIL_KEY);
    if (!email) email = window.prompt("Confirm the email address this link was sent to:") || "";
    if (email) {
      try {
        await signInWithEmailLink(auth, email, location.href);
        localStorage.removeItem(EMAIL_KEY);
        /* Strip the sign-in token out of the URL so a shared or bookmarked
           link can't be replayed by someone else. */
        history.replaceState(null, "", location.pathname + location.hash);
      } catch (e) {
        console.warn("email-link sign-in failed", e);
      }
    }
  }

  const named = (u) => !!(u && !u.isAnonymous);
  const current = await new Promise((res) => {
    const un = onAuthStateChanged(auth, (u) => { un(); res(u); });
  });
  if (named(current)) return { app, auth, user: current, signOut: () => signOut(auth) };

  /* Not signed in — put up the gate and wait. Nothing behind it renders. */
  const user = await gate(auth, { sendSignInLinkToEmail, label });
  return { app, auth, user, signOut: () => signOut(auth) };
}

function gate(auth, { sendSignInLinkToEmail, label }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.id = "hq-gate";
    wrap.innerHTML = `
      <style>
        #hq-gate{position:fixed;inset:0;z-index:2147483647;background:#111310;
          display:flex;align-items:center;justify-content:center;padding:24px;
          font:400 15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#EDEDEB}
        #hq-gate .box{width:100%;max-width:380px}
        #hq-gate h1{font-size:19px;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}
        #hq-gate p{margin:0 0 18px;color:#9A948B;font-size:14px}
        #hq-gate input{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:7px;
          border:1px solid #35302A;background:#191B18;color:#EDEDEB;font-size:15px}
        #hq-gate input:focus{outline:none;border-color:#5B8C6E}
        #hq-gate button{width:100%;margin-top:9px;padding:11px 13px;border:0;border-radius:7px;
          background:#5B8C6E;color:#0C0E0B;font-size:15px;font-weight:650;cursor:pointer}
        #hq-gate button:disabled{opacity:.55;cursor:default}
        #hq-gate .msg{margin-top:12px;font-size:13.5px;color:#9A948B;min-height:1.2em}
        #hq-gate .msg.ok{color:#7BC08D}
        #hq-gate .msg.err{color:#E8846A}
      </style>
      <div class="box">
        <h1>Sign in</h1>
        <p>${label} is private. Enter your email and we'll send a one-time link — no password, and this device stays signed in afterwards.</p>
        <input id="hq-mail" type="email" placeholder="you@example.com" autocomplete="email" autofocus>
        <button id="hq-go">Email me a link</button>
        <div class="msg" id="hq-msg"></div>
      </div>`;
    document.documentElement.appendChild(wrap);

    const mail = wrap.querySelector("#hq-mail");
    const go = wrap.querySelector("#hq-go");
    const msg = wrap.querySelector("#hq-msg");

    /* If the link is clicked in this same tab the page reloads and the
       isSignInWithEmailLink branch above handles it. If it's clicked
       elsewhere, this listener catches the state change and lifts the gate. */
    onAuthStateChanged_(auth, (u) => {
      if (u && !u.isAnonymous) { wrap.remove(); resolve(u); }
    });

    const send = async () => {
      const email = (mail.value || "").trim();
      if (!email) { msg.textContent = "Enter your email first."; msg.className = "msg err"; return; }
      go.disabled = true; msg.className = "msg"; msg.textContent = "Sending…";
      try {
        await sendSignInLinkToEmail(auth, email, {
          url: location.origin + location.pathname,
          handleCodeInApp: true,
        });
        localStorage.setItem(EMAIL_KEY, email);
        msg.className = "msg ok";
        msg.textContent = "Link sent. Open it on this device and you're in for good.";
      } catch (e) {
        msg.className = "msg err";
        msg.textContent = e && e.code === "auth/invalid-email"
          ? "That doesn't look like a valid email."
          : "Couldn't send it: " + ((e && e.code) || "unknown error");
        go.disabled = false;
      }
    };
    go.addEventListener("click", send);
    mail.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  });

  function onAuthStateChanged_(a, cb) {
    import(SDK + "firebase-auth.js").then(({ onAuthStateChanged }) => onAuthStateChanged(a, cb));
  }
}
