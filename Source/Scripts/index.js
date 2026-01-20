// /Source/Scripts/index.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    deleteUser,
    EmailAuthProvider,
    reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp,
    collection,
    addDoc,
    query,
    where,
    orderBy,
    limit,
    getDocs,
    onSnapshot,
    runTransaction,
    writeBatch,
    arrayUnion
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ---------------------------- Firebase config ---------------------------- */
// TODO: replace with your Firebase project config (Firebase Console → Project settings)
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCOLy-aVBG_-33hxoHty7Y952K4ds3LhVQ",
    authDomain: "chattest-eecfa.firebaseapp.com",
    projectId: "chattest-eecfa",
    appId: "1:718159354252:web:f3d3c717c27508d8365ea9"
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

/* ------------------------------ Interest data ---------------------------- */
const INTERESTS = [
    { category: "Sports", items: ["Basketball", "Soccer", "Hockey", "Baseball", "Tennis", "Running", "Gym"] },
    { category: "Video Games", items: ["Minecraft", "Fortnite", "Roblox", "Valorant", "Apex Legends", "League of Legends"] },
    { category: "Music", items: ["Hip-hop", "Pop", "Rock", "EDM", "Jazz", "Classical"] },
    { category: "Tech", items: ["AI", "Coding", "Phones", "PC Building", "Startups"] },
    { category: "Lifestyle", items: ["Travel", "Cooking", "Movies", "Books", "Photography"] }
];

/* ------------------------------- UI helpers ------------------------------ */
const $ = (id) => document.getElementById(id);

const views = {
    landing: $("viewLanding"),
    auth: $("viewAuth"),
    home: $("viewHome"),
    matching: $("viewMatching"),
    chat: $("viewChat"),
    settings: $("viewSettings")
};

function showView(name) {
    Object.values(views).forEach(v => v.classList.add("d-none"));
    views[name].classList.remove("d-none");
}

function toast(msg) {
    $("toastText").textContent = msg;
    const t = $("toast");
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
$("toastClose").addEventListener("click", () => $("toast").classList.remove("show"));

function nowMs() { return Date.now(); }

/* ----------------------------- App state --------------------------------- */
const state = {
    user: null,
    profile: null,

    filters: { sex: "either", interests: [] },

    matching: {
        active: false,
        unsubWaiting: null,
        retryTimer: null
    },

    chat: {
        id: null,
        docUnsub: null,
        msgUnsub: null,
        locked: true,
        partner: null,
        reported: false
    }
};

/* ---------------------------- Validation --------------------------------- */
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function validDisplayName(s) {
    if (!s) return false;
    const t = s.trim();
    return t.length >= 3 && t.length <= 16;
}
function validEmail(s) { return !!s && s.includes("@") && s.includes("."); }
function validPassword(s) { return !!s && s.length >= 6; }
function nonEmptyTrim(s) { return !!s && s.trim().length > 0; }

async function usernameIsFree(username, uidToIgnore = null) {
    // Minimal read: one indexed query
    const qy = query(collection(db, "users"), where("username", "==", username), limit(1));
    const snap = await getDocs(qy);
    if (snap.empty) return true;
    const found = snap.docs[0];
    return uidToIgnore && found.id === uidToIgnore;
}

/* ---------------------------- Firestore refs ----------------------------- */
const userRef = (uid) => doc(db, "users", uid);
const waitingRef = (uid) => doc(db, "waiting", uid);
const chatRef = (chatId) => doc(db, "chats", chatId);
const msgsRef = (chatId) => collection(db, "chats", chatId, "messages");

/* ---------------------------- Profile load/save -------------------------- */
async function loadProfile(uid) {
    const s = await getDoc(userRef(uid));
    if (!s.exists()) return null;
    return { uid, ...s.data() };
}

function applyTopBarAuthed(isAuthed) {
    $("btnTopSettings").classList.toggle("d-none", !isAuthed);
}

function setSettingsFormFromProfile(p) {
    $("stUsername").value = p.username || "";
    $("stDisplayName").value = p.displayName || "";
    $("stDob").value = p.dob || "";
    $("stSex").value = p.sex || "male";
}

function setFiltersUIFromProfile(p) {
    const f = p.filters || { sex: "either", interests: [] };
    state.filters = { sex: f.sex || "either", interests: Array.isArray(f.interests) ? f.interests : [] };
    $("filterSex").value = state.filters.sex;
    renderInterestPicker();
}

/* ----------------------------- Interest picker --------------------------- */
function renderInterestPicker() {
    const root = $("interestPicker");
    root.innerHTML = "";

    // render grouped badges
    INTERESTS.forEach(group => {
        const label = document.createElement("div");
        label.className = "w-100 small text-muted mt-2";
        label.textContent = group.category;
        root.appendChild(label);

        group.items.forEach(item => {
            const b = document.createElement("span");
            b.className = "badge text-bg-light badge-interest";
            if (state.filters.interests.includes(item)) b.classList.add("selected");
            b.textContent = item;
            b.addEventListener("click", () => {
                const ix = state.filters.interests.indexOf(item);
                if (ix >= 0) state.filters.interests.splice(ix, 1);
                else state.filters.interests.push(item);
                renderInterestPicker();
            });
            root.appendChild(b);
        });
    });
}

/* ---------------------------- Matching compatibility --------------------- */
function sexOk(filterSex, otherSex) {
    if (filterSex === "either") return otherSex === "male" || otherSex === "female";
    return filterSex === otherSex;
}

function interestsOk(requiredInterests, otherInterests) {
    const req = Array.isArray(requiredInterests) ? requiredInterests : [];
    if (req.length === 0) return true;
    const other = new Set(Array.isArray(otherInterests) ? otherInterests : []);
    return req.some(x => other.has(x));
}

function compatible(a, b) {
    // a.filters vs b.public
    const aSexOk = sexOk(a.filters.sex, b.public.sex);
    const aIntOk = interestsOk(a.filters.interests, b.public.interests);

    // b.filters vs a.public
    const bSexOk = sexOk(b.filters.sex, a.public.sex);
    const bIntOk = interestsOk(b.filters.interests, a.public.interests);

    return aSexOk && aIntOk && bSexOk && bIntOk;
}

/* ----------------------------- Listeners control ------------------------- */
function stopMatchingListener() {
    if (state.matching.unsubWaiting) state.matching.unsubWaiting();
    state.matching.unsubWaiting = null;
    if (state.matching.retryTimer) clearTimeout(state.matching.retryTimer);
    state.matching.retryTimer = null;
}

function stopChatListeners() {
    if (state.chat.docUnsub) state.chat.docUnsub();
    if (state.chat.msgUnsub) state.chat.msgUnsub();
    state.chat.docUnsub = null;
    state.chat.msgUnsub = null;
}

/* ----------------------------- Chat UI helpers --------------------------- */
function scrollMessagesToBottom() {
    const el = $("messages");
    el.scrollTop = el.scrollHeight;
}

function renderMessage({ type, senderUid, text }) {
    const row = document.createElement("div");

    if (type === "system") {
        row.className = "msg-row system";
        const b = document.createElement("div");
        b.className = "msg-bubble msg-system";
        b.textContent = text;
        row.appendChild(b);
        return row;
    }

    const me = senderUid === state.user.uid;
    row.className = `msg-row ${me ? "me" : "them"}`;

    const b = document.createElement("div");
    b.className = `msg-bubble ${me ? "msg-me" : "msg-them"}`;
    b.textContent = text;

    row.appendChild(b);
    return row;
}

function setChatLockedUI(locked, reasonText = "") {
    state.chat.locked = locked;
    $("btnSend").disabled = locked;
    $("msgInput").disabled = locked;
    $("chatLockedHint").textContent = locked ? (reasonText || "Chat is locked.") : "";
    $("chatStatusBadge").textContent = locked ? "Locked" : "Active";
    $("chatStatusBadge").className = locked ? "badge text-bg-secondary" : "badge text-bg-success";
}

/* ----------------------------- Core: enter/leave chat -------------------- */
async function attachChat(chatId) {
    stopChatListeners();
    state.chat.id = chatId;

    // Chat doc listener (1)
    state.chat.docUnsub = onSnapshot(chatRef(chatId), async (snap) => {
        if (!snap.exists()) {
            setChatLockedUI(true, "Chat not found (possibly cleaned up).");
            return;
        }
        const data = snap.data();
        state.chat.reported = !!data.reported;

        const locked = !!data.locked || data.status !== "active";
        if (locked) {
            let hint = "Chat ended.";
            if (data.endedReason === "rematch") hint = "Chat ended: partner rematched.";
            if (data.endedReason === "exit") hint = "Chat ended: partner exited.";
            if (data.endedReason === "reported") hint = "Chat ended: reported.";
            if (data.endedReason === "disconnect") hint = "Chat ended: partner closed the tab.";
            setChatLockedUI(true, hint);
        } else {
            setChatLockedUI(false);
        }

        $("btnReport").disabled = state.chat.reported;
    });

    // Messages listener (2)
    const qy = query(msgsRef(chatId), orderBy("ts", "asc"), limit(300));
    state.chat.msgUnsub = onSnapshot(qy, (snap) => {
        const root = $("messages");
        root.innerHTML = "";
        snap.forEach(d => root.appendChild(renderMessage(d.data())));
        scrollMessagesToBottom();
    });

    showView("chat");
}

/* ----------------------------- System message helper --------------------- */
async function addSystemMessage(chatId, text) {
    await addDoc(msgsRef(chatId), {
        type: "system",
        senderUid: "system",
        text,
        ts: serverTimestamp()
    });
}

/* ----------------------------- End/lock chat ----------------------------- */
async function endChat(reason, systemText, endedByUid) {
    const chatId = state.chat.id;
    if (!chatId) return;

    // Best-effort: transaction lock prevents double-end
    await runTransaction(db, async (tx) => {
        const cRef = chatRef(chatId);
        const cSnap = await tx.get(cRef);
        if (!cSnap.exists()) return;

        const c = cSnap.data();
        if (c.locked || c.status !== "active") return;

        tx.update(cRef, {
            status: "ended",
            locked: true,
            endedReason: reason,
            endedBy: endedByUid,
            endedAt: serverTimestamp()
        });
    });

    // Add system msg after lock (best-effort)
    try { await addSystemMessage(chatId, systemText); } catch (_) { }

    // UI updates: do not auto-navigate partner (we only navigate current user via button flows)
}

/* ----------------------------- Cleanup (client-only best effort) ---------- */
async function tryDeleteChatFully(chatId) {
    // Tradeoff: deleting a subcollection requires reads.
    // We keep this best-effort and capped to reduce costs.
    try {
        const qy = query(msgsRef(chatId), orderBy("ts", "asc"), limit(200));
        const snap = await getDocs(qy);

        const batch = writeBatch(db);
        snap.forEach(d => batch.delete(d.ref));
        batch.delete(chatRef(chatId));
        await batch.commit();
    } catch (_) {
        // ignore: TTL / later load cleanup may remove it
    }
}

async function bestEffortCleanupOnLoad(uid) {
    // Optional: attempt to delete your own old ended chats you’re still referenced in (limited)
    // Minimal reads: query by userA/userB would need composite indexes; keep light.
    // You can extend with indexes if desired.
}

/* ----------------------------- Matching flow ----------------------------- */
async function startMatching() {
    if (!state.user || !state.profile) return;

    state.matching.active = true;
    showView("matching");

    // Create/update waiting doc (one write)
    const my = {
        uid: state.user.uid,
        status: "waiting",
        createdAt: serverTimestamp(),
        // snapshot used for compatibility with minimal reads
        public: {
            username: state.profile.username,
            displayName: state.profile.displayName,
            sex: state.profile.sex,
            interests: state.profile.filters?.interests || []
        },
        filters: {
            sex: state.filters.sex || "either",
            interests: state.filters.interests || []
        },
        assignedChatId: null
    };
    await setDoc(waitingRef(state.user.uid), my, { merge: true });

    // Listen only to your waiting doc (3)
    stopMatchingListener();
    state.matching.unsubWaiting = onSnapshot(waitingRef(state.user.uid), async (snap) => {
        if (!snap.exists()) return;
        const w = snap.data();
        if (w.status === "matched" && w.assignedChatId) {
            stopMatchingListener();
            state.matching.active = false;
            await joinMatchedChat(w.assignedChatId);
        }
    });

    // Attempt immediate transaction match (no loops; then backoff retries)
    await attemptMatchTransaction();
    scheduleRetry();
}

function scheduleRetry() {
    // lightweight backoff retries; no extra listeners
    if (!state.matching.active) return;
    const base = 1200;
    const jitter = Math.floor(Math.random() * 600);
    const delay = base + jitter;

    state.matching.retryTimer = setTimeout(async () => {
        if (!state.matching.active) return;
        await attemptMatchTransaction();
        scheduleRetry();
    }, delay);
}

async function attemptMatchTransaction() {
    const uid = state.user.uid;
    const myWRef = waitingRef(uid);

    try {
        await runTransaction(db, async (tx) => {
            const mySnap = await tx.get(myWRef);
            if (!mySnap.exists()) return;
            const me = mySnap.data();
            if (me.status !== "waiting") return; // already matched/cancelled

            // Query a few candidates, then pick first compatible.
            // Note: transactions can read query results.
            const qy = query(
                collection(db, "waiting"),
                where("status", "==", "waiting"),
                orderBy("createdAt", "asc"),
                limit(10)
            );
            const candSnap = await getDocs(qy); // allowed inside transaction in SDK

            let chosen = null;
            candSnap.forEach(d => {
                if (chosen) return;
                if (d.id === uid) return;
                const other = d.data();
                if (other.status !== "waiting") return;
                if (!other.public || !other.filters) return;

                if (compatible(me, other)) chosen = { id: d.id, data: other };
            });

            if (!chosen) return;

            // Create chat
            const chatId = `${uid}_${chosen.id}_${nowMs()}`;
            const cRef = chatRef(chatId);

            tx.set(cRef, {
                userA: uid,
                userB: chosen.id,
                status: "active",
                locked: false,
                createdAt: serverTimestamp(),
                reported: false
            });

            // Claim both waiting docs.
            // Security rules: partner waiting updates are restricted to a narrow set of fields.
            tx.update(myWRef, { status: "matched", assignedChatId: chatId });
            tx.update(waitingRef(chosen.id), { status: "matched", assignedChatId: chatId, matchedBy: uid });

            // First system message (write as normal after transaction, to keep transaction lean)
        });

        // If we matched, add “Matched.” system message (best effort)
        // We don’t know chatId here without re-reading waiting doc; do one read if needed:
        const w = await getDoc(waitingRef(uid));
        const chatId = w.exists() ? w.data().assignedChatId : null;
        if (chatId) {
            try { await addSystemMessage(chatId, "Matched."); } catch (_) { }
        }
    } catch (_) {
        // ignore transient errors; retry will happen
    }
}

async function joinMatchedChat(chatId) {
    // Delete waiting doc to reduce “pool clutter”
    try { await deleteDoc(waitingRef(state.user.uid)); } catch (_) { }

    // Load partner public info from chat doc (one read)
    const cSnap = await getDoc(chatRef(chatId));
    if (!cSnap.exists()) {
        // partner/unavailable edge case
        toast("Partner unavailable.");
        showView("home");
        return;
    }
    const c = cSnap.data();
    const partnerUid = (c.userA === state.user.uid) ? c.userB : c.userA;

    const pSnap = await getDoc(userRef(partnerUid));
    if (!pSnap.exists()) {
        toast("Partner unavailable.");
        showView("home");
        return;
    }

    state.chat.partner = { uid: partnerUid, ...pSnap.data() };
    $("partnerName").textContent = state.chat.partner.displayName || "Partner";
    $("partnerUsername").textContent = "@" + (state.chat.partner.username || "user");
    $("partnerSex").textContent = state.chat.partner.sex || "—";

    $("btnReport").disabled = !!c.reported;

    await attachChat(chatId);
}

/* ----------------------------- Cancel matching --------------------------- */
async function cancelMatching() {
    state.matching.active = false;
    stopMatchingListener();
    try { await deleteDoc(waitingRef(state.user.uid)); } catch (_) { }
    toast("Matching cancelled.");
    showView("home");
}

/* ----------------------------- Auth flows ------------------------------- */
async function handleSignup() {
    const username = $("suUsername").value.trim();
    const displayName = $("suDisplayName").value.trim();
    const email = $("suEmail").value.trim();
    const password = $("suPassword").value;
    const dob = $("suDob").value;
    const sex = $("suSex").value;

    if (!USERNAME_RE.test(username)) return toast("Invalid username.");
    if (!validDisplayName(displayName)) return toast("Invalid display name.");
    if (!validEmail(email)) return toast("Invalid email.");
    if (!validPassword(password)) return toast("Password must be 6+ chars.");
    if (!dob) return toast("DOB required.");
    if (sex !== "male" && sex !== "female") return toast("Select sex.");

    if (!(await usernameIsFree(username))) return toast("Username already taken.");

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;

    const profile = {
        username,
        displayName,
        email,
        dob,
        sex,
        filters: { sex: "either", interests: [] },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

    await setDoc(userRef(uid), profile);
}

async function handleLogin() {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;

    if (!validEmail(email)) return toast("Invalid email.");
    if (!nonEmptyTrim(password)) return toast("Enter password.");

    await signInWithEmailAndPassword(auth, email, password);
}

/* ----------------------------- Settings save/delete ---------------------- */
async function saveSettings() {
    const uid = state.user.uid;
    const newUsername = $("stUsername").value.trim();
    const newDisplayName = $("stDisplayName").value.trim();
    const newDob = $("stDob").value;
    const newSex = $("stSex").value;

    if (!USERNAME_RE.test(newUsername)) return toast("Invalid username.");
    if (!validDisplayName(newDisplayName)) return toast("Invalid display name.");
    if (!newDob) return toast("DOB required.");
    if (newSex !== "male" && newSex !== "female") return toast("Select sex.");

    if (!(await usernameIsFree(newUsername, uid))) return toast("Username already taken.");

    await updateDoc(userRef(uid), {
        username: newUsername,
        displayName: newDisplayName,
        dob: newDob,
        sex: newSex,
        updatedAt: serverTimestamp()
    });

    // Refresh in-memory profile
    state.profile = await loadProfile(uid);
    setFiltersUIFromProfile(state.profile);
    toast("Saved.");
    showView("home");
}

async function logout() {
    // Best-effort cleanup
    try { await deleteDoc(waitingRef(state.user.uid)); } catch (_) { }
    stopMatchingListener();
    stopChatListeners();
    state.chat.id = null;
    await signOut(auth);
}

async function deleteAccountFlow() {
    if (!confirm("Delete your account? This cannot be undone.")) return;

    // Best-effort: end active chat as a disconnect/exit before delete
    try {
        if (state.chat.id) {
            await endChat("exit", `${state.profile.displayName} has exited.`, state.user.uid);
            await tryDeleteChatFully(state.chat.id);
        }
    } catch (_) { }

    // Remove waiting doc
    try { await deleteDoc(waitingRef(state.user.uid)); } catch (_) { }

    // Remove profile doc
    try { await deleteDoc(userRef(state.user.uid)); } catch (_) { }

    // Delete auth user (may require recent login)
    try {
        await deleteUser(auth.currentUser);
    } catch (e) {
        // If requires recent login, prompt once
        const pw = prompt("For security, re-enter your password to delete the account:");
        if (!pw) return toast("Account deletion cancelled.");
        const cred = EmailAuthProvider.credential(auth.currentUser.email, pw);
        await reauthenticateWithCredential(auth.currentUser, cred);
        await deleteUser(auth.currentUser);
    }
}

/* ----------------------------- Chat actions ------------------------------ */
async function sendMessage() {
    const chatId = state.chat.id;
    if (!chatId) return;

    const text = $("msgInput").value.trim();
    if (!text) return;

    // One write; rules block if locked
    $("msgInput").value = "";
    await addDoc(msgsRef(chatId), {
        type: "user",
        senderUid: state.user.uid,
        text,
        ts: serverTimestamp()
    });
    scrollMessagesToBottom();
}

async function rematch() {
    if (!state.chat.id) return;
    const chatId = state.chat.id;

    await endChat("rematch", `${state.profile.displayName} has rematched.`, state.user.uid);

    // Best-effort cleanup attempt by the ender
    try { await tryDeleteChatFully(chatId); } catch (_) { }

    // Current user goes to matching
    stopChatListeners();
    state.chat.id = null;
    await startMatching();
}

async function exitChat() {
    if (!state.chat.id) return;
    const chatId = state.chat.id;

    await endChat("exit", `${state.profile.displayName} has exited.`, state.user.uid);

    try { await tryDeleteChatFully(chatId); } catch (_) { }

    stopChatListeners();
    state.chat.id = null;
    showView("home");
}

function openReportModal() {
    if ($("btnReport").disabled) return;
    $("reportModal").classList.add("show");
    $("reportModal").style.display = "block";
    document.body.classList.add("modal-open");
}
function closeReportModal() {
    $("reportModal").classList.remove("show");
    $("reportModal").style.display = "none";
    document.body.classList.remove("modal-open");
}

async function reportChatConfirmed() {
    closeReportModal();
    const chatId = state.chat.id;
    if (!chatId) return;

    // Lock/end immediately
    await endChat("reported", `${state.profile.displayName} reported this chat.`, state.user.uid);

    // Copy full chat into reports/{id} then delete original
    try {
        const cSnap = await getDoc(chatRef(chatId));
        if (!cSnap.exists()) return;

        const c = cSnap.data();
        if (c.reported) {
            toast("Already reported.");
            return;
        }

        // Pull messages (reads) capped
        const mSnap = await getDocs(query(msgsRef(chatId), orderBy("ts", "asc"), limit(300)));
        const messages = [];
        mSnap.forEach(d => messages.push(d.data()));

        // Pull both users public info (2 reads)
        const aUid = c.userA, bUid = c.userB;
        const [aSnap, bSnap] = await Promise.all([getDoc(userRef(aUid)), getDoc(userRef(bUid))]);

        const reportDoc = {
            chat: { ...c, id: chatId },
            userA: aSnap.exists() ? pickPublicUser(aSnap.data()) : { uid: aUid },
            userB: bSnap.exists() ? pickPublicUser(bSnap.data()) : { uid: bUid },
            reporterUid: state.user.uid,
            createdAt: serverTimestamp(),
            messages
        };

        const repRef = await addDoc(collection(db, "reports"), reportDoc);

        // Mark chat reported + lock (so partner disables report button)
        await updateDoc(chatRef(chatId), { reported: true, locked: true, status: "ended" });

        // Message for partner (“reported and rematched” per spec)
        try { await addSystemMessage(chatId, `${state.profile.displayName} reported this chat and rematched.`); } catch (_) { }

        // Delete original chat/messages best-effort
        await tryDeleteChatFully(chatId);

        toast("Reported. Thank you.");
    } catch (_) {
        toast("Report failed (try again).");
    }

    // Reporter goes home
    stopChatListeners();
    state.chat.id = null;
    showView("home");
}

function pickPublicUser(u) {
    return {
        username: u.username,
        displayName: u.displayName,
        sex: u.sex
    };
}

/* ----------------------------- Presence / tab close (best-effort) -------- */
function installBestEffortPresence() {
    // No extra listeners; best-effort write on unload/visibility change.
    // Not guaranteed to fire; for “true presence” you’d need RTDB onDisconnect
    // but that adds another live listener (and more moving parts).
    window.addEventListener("beforeunload", () => {
        // Try to lock chat as disconnect
        if (state.user && state.profile && state.chat.id && !state.chat.locked) {
            // Fire-and-forget; may not complete
            endChat("disconnect", `${state.profile.displayName} closed the tab.`, state.user.uid);
        }
    });

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            if (state.user && state.profile && state.chat.id && !state.chat.locked) {
                endChat("disconnect", `${state.profile.displayName} closed the tab.`, state.user.uid);
            }
        }
    });
}

/* ----------------------------- Interest suggestion ----------------------- */
async function suggestInterest() {
    const text = $("interestSuggestText").value.trim();
    if (!text) return toast("Type an interest first.");
    if (text.length > 40) return toast("Too long.");
    $("interestSuggestText").value = "";

    await addDoc(collection(db, "interestSuggestions"), {
        uid: state.user.uid,
        text,
        ts: serverTimestamp()
    });
    toast("Suggestion sent.");
}

/* ----------------------------- Event wiring ------------------------------ */
$("goLogin").addEventListener("click", () => showView("auth"));
$("goSignup").addEventListener("click", () => showView("auth"));
$("authToSignup").addEventListener("click", () => showView("auth"));
$("authToLogin").addEventListener("click", () => showView("auth"));

$("btnLogin").addEventListener("click", async () => {
    try { await handleLogin(); } catch (e) { toast(e.message || "Login failed."); }
});
$("btnSignup").addEventListener("click", async () => {
    try { await handleSignup(); } catch (e) { toast(e.message || "Signup failed."); }
});

$("btnSettings").addEventListener("click", () => {
    if (!state.profile) return;
    setSettingsFormFromProfile(state.profile);
    showView("settings");
});
$("btnTopSettings").addEventListener("click", () => {
    if (!state.profile) return;
    setSettingsFormFromProfile(state.profile);
    showView("settings");
});
$("btnBackHome").addEventListener("click", () => showView("home"));
$("brandHome").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.user) showView("home");
    else showView("landing");
});

$("filterSex").addEventListener("change", () => {
    state.filters.sex = $("filterSex").value;
});

$("btnSuggestInterest").addEventListener("click", async () => {
    try { await suggestInterest(); } catch (e) { toast("Failed."); }
});

$("btnMatch").addEventListener("click", async () => {
    try {
        // Save filters snapshot to profile (one write)
        await updateDoc(userRef(state.user.uid), {
            filters: { sex: state.filters.sex, interests: state.filters.interests },
            updatedAt: serverTimestamp()
        });
        state.profile = await loadProfile(state.user.uid);
        await startMatching();
    } catch (e) {
        toast("Match failed.");
    }
});

$("btnCancelMatching").addEventListener("click", async () => {
    await cancelMatching();
});

$("btnSend").addEventListener("click", async () => {
    try { await sendMessage(); } catch (_) { toast("Cannot send (chat locked)."); }
});
$("msgInput").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        try { await sendMessage(); } catch (_) { toast("Cannot send (chat locked)."); }
    }
});

$("btnRematch").addEventListener("click", async () => {
    try { await rematch(); } catch (_) { toast("Failed."); }
});
$("btnExitChat").addEventListener("click", async () => {
    try { await exitChat(); } catch (_) { toast("Failed."); }
});

$("btnReport").addEventListener("click", () => openReportModal());
$("reportModalClose").addEventListener("click", () => closeReportModal());
$("reportModalCancel").addEventListener("click", () => closeReportModal());
$("reportModalConfirm").addEventListener("click", async () => {
    try { await reportChatConfirmed(); } catch (_) { toast("Report failed."); }
});

$("btnSaveSettings").addEventListener("click", async () => {
    try { await saveSettings(); } catch (e) { toast(e.message || "Save failed."); }
});
$("btnLogout").addEventListener("click", async () => {
    try { await logout(); } catch (_) { toast("Logout failed."); }
});
$("btnDeleteAccount").addEventListener("click", async () => {
    try { await deleteAccountFlow(); } catch (e) { toast(e.message || "Delete failed."); }
});

/* ----------------------------- Auth state bootstrap ---------------------- */
onAuthStateChanged(auth, async (u) => {
    stopMatchingListener();
    stopChatListeners();
    state.chat.id = null;

    if (!u) {
        state.user = null;
        state.profile = null;
        applyTopBarAuthed(false);
        showView("landing");
        return;
    }

    state.user = u;
    applyTopBarAuthed(true);

    // Load profile
    state.profile = await loadProfile(u.uid);
    if (!state.profile) {
        // Defensive: user exists but profile missing
        toast("Profile missing. Please sign up again.");
        await signOut(auth);
        return;
    }

    setFiltersUIFromProfile(state.profile);
    showView("home");
    installBestEffortPresence();

    // Best-effort cleanup of stale items
    bestEffortCleanupOnLoad(u.uid);
});
