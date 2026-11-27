// ============================
// AUTH STATE
// ============================

let currentUser = null;

const authScreen = document.getElementById("authScreen");
const app = document.getElementById("app");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const showRegister = document.getElementById("showRegister");
const showLogin = document.getElementById("showLogin");
const authError = document.getElementById("authError");
const logoutBtn = document.getElementById("logoutBtn");

// Older versions kept a copy of the chat in localStorage and sent it to the
// server. History now comes from the server's database, so drop the old copy.
localStorage.removeItem("conversation");

const MAX_MESSAGE_CHARS = 8000;
const MAX_FILES_PER_MESSAGE = 5;

fetch("/api/model-info")
  .then((response) => response.ok ? response.json() : null)
  .then((info) => {
    if (!info?.model) return;
    document.querySelectorAll("[data-model-name]").forEach((element) => {
      element.textContent = info.model;
    });
    const retention = info.retentionDays
      ? `Chats are deleted automatically ${info.retentionDays} days after their last message.`
      : "Chats are kept until you delete them.";
    document.querySelectorAll("[data-retention]").forEach((element) => {
      element.textContent = retention;
    });
  })
  .catch(() => {});
const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");
const userAvatar = document.getElementById("userAvatar");


// ============================
// THEME
// ============================

const themeToggle = document.getElementById("themeToggle");

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

const savedTheme = localStorage.getItem("theme") || "light";
applyTheme(savedTheme);

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});


// ============================
// PASSWORD VISIBILITY TOGGLE
// ============================

document.querySelectorAll(".password-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.classList.toggle("showing", !showing);
    btn.title = showing ? "Show password" : "Hide password";
    btn.setAttribute("aria-label", btn.title);
  });
});


// ============================
// AUTH HELPERS
// ============================

function showAuthError(message) {
  authError.classList.remove("success");
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function showAuthSuccess(message) {
  authError.classList.add("success");
  authError.textContent = message;
  authError.classList.remove("hidden");
}

function hideAuthError() {
  authError.classList.add("hidden");
  authError.classList.remove("success");
}

function showAuthScreen() {
  authScreen.classList.remove("hidden");
  app.classList.add("hidden");
}

function showApp() {
  authScreen.classList.add("hidden");
  app.classList.remove("hidden");
}

function updateUserUI(user) {
  currentUser = user;
  userName.textContent = user.name || "User";
  userEmail.textContent = user.email;
  userAvatar.textContent = (user.name || user.email).charAt(0).toUpperCase();
}

async function checkAuth() {
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    if (data.user) {
      updateUserUI(data.user);
      showApp();
      await loadActiveConversation();
      loadConversations();
    } else {
      showAuthScreen();
    }
  } catch {
    showAuthScreen();
  }
}

async function login(email, password) {
  hideAuthError();
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  if (!response.ok) {
    showAuthError(data.error || "Login failed");
    return false;
  }
  updateUserUI(data.user);
  showView("chat");
  showApp();
  if (data.reactivated) showToast("Welcome back! Your account has been reactivated.");
  await loadActiveConversation();
  loadConversations();
  return true;
}

function showToast(message) {
  document.querySelector(".info-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "delete-toast info-toast";
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => toast.remove(), 5000);
}

async function register(name, email, password) {
  hideAuthError();
  const response = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password })
  });
  const data = await response.json();
  if (!response.ok) {
    showAuthError(data.error || "Registration failed");
    return false;
  }

  registerForm.reset();
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  document.getElementById("loginEmail").value = email;
  showAuthSuccess(data.message || "Registration successful. Please check your email to verify your account, then sign in.");
  return true;
}

async function logout() {
  stopGenerating();
  await fetch("/api/auth/logout", { method: "POST" });
  currentUser = null;
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  showWelcome();
  showView("chat");
  showAuthScreen();
}

function showWelcome() {
  const template = document.getElementById("welcomeTemplate");
  messages.innerHTML = "";
  messages.appendChild(template.content.cloneNode(true));
  // Re-apply the retention text fetched at startup.
  const known = document.querySelector("#authScreen [data-retention]");
  messages.querySelectorAll("[data-retention]").forEach((el) => {
    if (known) el.textContent = known.textContent;
  });
  document.querySelectorAll("#messages [data-model-name]").forEach((el) => {
    const label = document.querySelector(".sidebar-title [data-model-name]");
    if (label) el.textContent = label.textContent;
  });
}


// ============================
// AUTH FORM HANDLERS
// ============================

const forgotForm = document.getElementById("forgotForm");
const resetForm = document.getElementById("resetForm");
const AUTH_FORMS = { login: loginForm, register: registerForm, forgot: forgotForm, reset: resetForm };

function showAuthForm(name) {
  for (const [key, form] of Object.entries(AUTH_FORMS)) {
    form.classList.toggle("hidden", key !== name);
  }
  hideAuthError();
  AUTH_FORMS[name].querySelector("input")?.focus();
}

showRegister.addEventListener("click", () => showAuthForm("register"));
showLogin.addEventListener("click", () => showAuthForm("login"));
document.getElementById("showForgot").addEventListener("click", () => {
  const typed = document.getElementById("loginEmail").value.trim();
  showAuthForm("forgot");
  if (typed) document.getElementById("forgotEmail").value = typed;
});
document.querySelectorAll(".back-to-login").forEach((btn) => {
  btn.addEventListener("click", () => showAuthForm("login"));
});

forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  const email = document.getElementById("forgotEmail").value.trim();
  const submitBtn = forgotForm.querySelector(".auth-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Sending...";
  try {
    const response = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Couldn't send the reset email.");
    showAuthSuccess(data.message);
  } catch (error) {
    showAuthError(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send reset link";
  }
});

// The token from the emailed link (?reset=...). It's removed from the address
// bar straight away so it doesn't stay in browser history.
let resetToken = null;

resetForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideAuthError();
  const password = document.getElementById("resetPassword").value;
  const confirm = document.getElementById("resetPasswordConfirm").value;
  if (password !== confirm) {
    showAuthError("The two passwords don't match.");
    return;
  }
  const submitBtn = resetForm.querySelector(".auth-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Resetting...";
  try {
    const response = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: resetToken, password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Couldn't reset your password.");
    resetToken = null;
    resetForm.reset();
    showAuthForm("login");
    showAuthSuccess(data.message);
  } catch (error) {
    showAuthError(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Reset password";
  }
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const submitBtn = loginForm.querySelector(".auth-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in...";
  const success = await login(email, password);
  submitBtn.disabled = false;
  submitBtn.textContent = "Sign in";
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const submitBtn = registerForm.querySelector(".auth-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating...";
  const success = await register(name, email, password);
  submitBtn.disabled = false;
  submitBtn.textContent = "Create account";
});

logoutBtn.addEventListener("click", logout);


// ============================
// CONVERSATION STATE
// ============================

const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const messages = document.getElementById("messages");
const typing = document.getElementById("typing");
const newChatBtn = document.getElementById("newChatBtn");
const conversationList = document.getElementById("conversationList");
const fileInput = document.getElementById("fileInput");
const attachBtn = document.getElementById("attachBtn");
const attachmentList = document.getElementById("attachmentList");

let activeConversationId = null;
let activeConversationTitle = null;

function saveActiveConversation() {
  if (activeConversationId) {
    localStorage.setItem("activeConversationId", activeConversationId.toString());
  } else {
    localStorage.removeItem("activeConversationId");
  }
}

async function loadActiveConversation() {
  const id = localStorage.getItem("activeConversationId");
  if (id) {
    await loadConversation(parseInt(id, 10));
  }
}


// ============================
// FILE ATTACHMENTS
// ============================

let pendingAttachments = []; // { id, filename, uploading }

function renderAttachments() {
  if (pendingAttachments.length === 0) {
    attachmentList.classList.add("hidden");
    attachmentList.innerHTML = "";
    return;
  }

  attachmentList.classList.remove("hidden");
  attachmentList.innerHTML = "";

  pendingAttachments.forEach((att) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip" + (att.uploading ? " uploading" : "");

    const label = document.createElement("span");
    label.textContent = att.uploading
      ? `Uploading ${att.filename}...`
      : att.truncated ? `${att.filename} (only the first part will be read)` : att.filename;
    if (att.truncated) label.title = "This file is long, so only its first 8,000 characters are sent to the AI.";
    chip.appendChild(label);

    if (!att.uploading) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        pendingAttachments = pendingAttachments.filter((a) => a !== att);
        renderAttachments();
      });
      chip.appendChild(removeBtn);
    }

    attachmentList.appendChild(chip);
  });
}

async function uploadFile(file) {
  if (pendingAttachments.length >= MAX_FILES_PER_MESSAGE) {
    alert(`You can attach up to ${MAX_FILES_PER_MESSAGE} files per message.`);
    return;
  }
  const pending = { id: null, filename: file.name, uploading: true, truncated: false };
  pendingAttachments.push(pending);
  renderAttachments();

  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Upload failed");

    pending.id = data.file.id;
    pending.truncated = Boolean(data.file.truncated);
    pending.uploading = false;
    renderAttachments();
  } catch (error) {
    pendingAttachments = pendingAttachments.filter((a) => a !== pending);
    renderAttachments();
    alert(error.message || "Upload failed");
  }
}

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  files.forEach(uploadFile);
  fileInput.value = "";
});


// ============================
// LOAD CONVERSATIONS
// ============================

async function loadConversations() {
  try {
    const response = await fetch("/api/conversations");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load conversations");

    conversationList.innerHTML = "";
    data.conversations.forEach((conv) => {
      const item = document.createElement("div");
      item.className = "conversation-item";

      const btn = document.createElement("button");
      btn.className = "conversation";
      btn.dataset.id = conv.id;
      if (conv.id === activeConversationId) btn.classList.add("active");
      btn.textContent = conv.title;
      btn.addEventListener("click", () => loadConversation(conv.id));

      const del = document.createElement("button");
      del.className = "delete-conv";
      del.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
      del.title = "Delete conversation";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        showDeleteConfirm(conv.id);
      });

      item.appendChild(btn);
      item.appendChild(del);
      conversationList.appendChild(item);
    });
  } catch (error) {
    console.error("Failed to load conversations:", error);
  }
}


// ============================
// LOAD SINGLE CONVERSATION
// ============================

function markActiveConversationInList() {
  conversationList.querySelectorAll(".conversation").forEach((btn) => {
    btn.classList.toggle("active", parseInt(btn.dataset.id, 10) === activeConversationId);
  });
}

async function loadConversation(id) {
  if (id !== activeConversationId) stopGenerating();
  showView("chat");
  try {
    const response = await fetch(`/api/conversations/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load conversation");

    activeConversationId = id;
    activeConversationTitle = data.conversation.title;
    saveActiveConversation();
    markActiveConversationInList();

    messages.innerHTML = "";
    data.messages.forEach((msg) => addMessage(msg.role, msg.content, msg.attachments || []));

    messageInput.focus();
  } catch (error) {
    console.error("Failed to load conversation:", error);
    activeConversationId = null;
    activeConversationTitle = null;
    saveActiveConversation();
  }
}


// ============================
// SEND MESSAGE (STREAMING)
// ============================

let currentRequest = null; // AbortController while a reply is streaming

function setGenerating(isGenerating) {
  sendBtn.classList.toggle("stop", isGenerating);
  sendBtn.textContent = isGenerating ? "■" : "↑";
  sendBtn.title = isGenerating ? "Stop generating" : "Send";
  sendBtn.setAttribute("aria-label", sendBtn.title);
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;

  if (message.length > MAX_MESSAGE_CHARS) {
    alert(`Your message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters). Attach long text as a file instead.`);
    return;
  }

  if (pendingAttachments.some((a) => a.uploading)) {
    alert("Please wait for the attachment to finish uploading.");
    return;
  }

  document.getElementById("welcome")?.remove();

  const attachedNames = pendingAttachments.map((a) => a.filename);
  addMessage("user", message, attachedNames);
  messageInput.value = "";
  typing.style.display = "flex";

  const aiMessageEl = createStreamingMessage("assistant");
  let fullResponse = "";
  currentRequest = new AbortController();
  setGenerating(true);

  try {
    // Only the new message is sent: the server reads earlier turns from its database.
    const body = { message };
    if (activeConversationId) body.conversationId = activeConversationId;
    if (pendingAttachments.length) body.fileIds = pendingAttachments.map((a) => a.id);
    pendingAttachments = [];
    renderAttachments();

    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: currentRequest.signal
    });

    if (!response.ok || !response.body) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || "Something went wrong");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let json;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }

        if (json.conversationId && !activeConversationId) {
          activeConversationId = json.conversationId;
          saveActiveConversation();
          loadConversations();
        }
        if (json.status === "thinking") {
          typing.style.display = "flex";
        }
        if (json.chunk) {
          if (typing.style.display !== "none") typing.style.display = "none";
          fullResponse += json.chunk;
          appendToStreamingMessage(aiMessageEl, json.chunk);
        }
        if (json.done) {
          finalizeStreamingMessage(aiMessageEl, fullResponse);
        }
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      // The user pressed Stop. The server saves what was generated and marks it as stopped.
      const note = "[Reply stopped before it finished.]";
      fullResponse = fullResponse ? `${fullResponse}\n\n${note}` : note;
      finalizeStreamingMessage(aiMessageEl, fullResponse);
    } else {
      console.error("Chat error:", error);
      if (fullResponse) {
        finalizeStreamingMessage(aiMessageEl, `${fullResponse}\n\n[Connection lost before the reply finished.]`);
      } else {
        aiMessageEl.remove();
        addMessage("assistant", `Error: ${error.message}`);
      }
    }
  } finally {
    currentRequest = null;
    setGenerating(false);
    typing.style.display = "none";
    messageInput.focus();
  }
}


// ============================
// STREAMING MESSAGE HELPERS
// ============================

function createStreamingMessage(role) {
  const messageElement = document.createElement("div");
  messageElement.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  if (role === "user") avatar.textContent = "You";
  else avatar.innerHTML = '<img src="/arisa-icon.png" alt="ARISA" />';

  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  messageContent.textContent = "";

  messageElement.appendChild(avatar);
  messageElement.appendChild(messageContent);
  messages.appendChild(messageElement);
  messages.scrollTop = messages.scrollHeight;
  return messageElement;
}

function appendToStreamingMessage(messageEl, chunk) {
  const contentEl = messageEl.querySelector(".message-content");
  contentEl.textContent += chunk;
  messages.scrollTop = messages.scrollHeight;
}

function finalizeStreamingMessage(messageEl, text) {
  if (!text) return;
  const contentEl = messageEl.querySelector(".message-content");
  contentEl.textContent = text;
}


// ============================
// ADD MESSAGE
// ============================

function addMessage(role, text, attachmentNames = []) {
  const messageElement = document.createElement("div");
  messageElement.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  if (role === "user") avatar.textContent = "You";
  else avatar.innerHTML = '<img src="/arisa-icon.png" alt="ARISA" />';

  const messageContent = document.createElement("div");
  messageContent.className = "message-content";
  messageContent.textContent = text;

  messageElement.appendChild(avatar);
  messageElement.appendChild(messageContent);

  if (attachmentNames.length) {
    const attachmentNote = document.createElement("div");
    attachmentNote.className = "message-attachments";
    attachmentNote.textContent = `📎 ${attachmentNames.join(", ")}`;
    messageElement.appendChild(attachmentNote);
  }

  messages.appendChild(messageElement);
  messages.scrollTop = messages.scrollHeight;
}


// ============================
// DELETE CONFIRMATION TOAST
// ============================

function showDeleteConfirm(id) {
  const existing = document.querySelector(".delete-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "delete-toast";
  toast.innerHTML = `
    <span>Are you sure you want to delete?</span>
    <div class="toast-actions">
      <button class="toast-cancel">Cancel</button>
      <button class="toast-confirm">Delete</button>
    </div>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));

  toast.querySelector(".toast-cancel").addEventListener("click", () => toast.remove());
  toast.querySelector(".toast-confirm").addEventListener("click", async () => {
    toast.remove();
    await deleteConversation(id);
  });
}


// ============================
// DELETE CONVERSATION
// ============================

async function deleteConversation(id) {
  try {
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to delete conversation");

    if (activeConversationId === id) {
      stopGenerating();
      activeConversationId = null;
      activeConversationTitle = null;
      saveActiveConversation();
      showWelcome();
    }
    loadConversations();
  } catch (error) {
    console.error("Failed to delete conversation:", error);
  }
}


// ============================
// NEW CHAT
// ============================

function stopGenerating() {
  if (currentRequest) currentRequest.abort();
}

newChatBtn.addEventListener("click", () => {
  stopGenerating();
  showView("chat");
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  markActiveConversationInList();
  showWelcome();
  messageInput.value = "";
  messageInput.focus();
});


// ============================
// VIEWS (chat / profile / settings)
// ============================

const chatView = document.getElementById("chatView");
const profileView = document.getElementById("profileView");
const settingsView = document.getElementById("settingsView");
const profileBtn = document.getElementById("profileBtn");

function showView(name) {
  chatView.classList.toggle("hidden", name !== "chat");
  profileView.classList.toggle("hidden", name !== "profile");
  settingsView.classList.toggle("hidden", name !== "settings");
  profileBtn.classList.toggle("active", name === "profile" || name === "settings");
  if (name === "chat") messageInput.focus();
}

profileBtn.addEventListener("click", () => {
  showView("profile");
  loadProfile();
});

document.querySelectorAll("[data-back-to-chat]").forEach((btn) => {
  btn.addEventListener("click", () => showView("chat"));
});

document.getElementById("openSettingsBtn").addEventListener("click", () => {
  showView("settings");
  settingsView.querySelector(".page-body").scrollTop = 0;
});
document.getElementById("settingsBackBtn").addEventListener("click", () => showView("profile"));


// ============================
// PROFILE
// ============================

const profileForm = document.getElementById("profileForm");
const profileNameInput = document.getElementById("profileNameInput");
const profileSaveStatus = document.getElementById("profileSaveStatus");

function formatJoined(sqliteDate) {
  // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
  const date = new Date(sqliteDate.replace(" ", "T") + "Z");
  return isNaN(date) ? sqliteDate : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function renderProfileHeader(name, email) {
  document.getElementById("profileAvatar").textContent = (name || email).charAt(0).toUpperCase();
  document.getElementById("profileName").textContent = name || "No display name";
  document.getElementById("profileEmail").textContent = email;
}

async function loadProfile() {
  profileView.querySelector(".page-body").scrollTop = 0;
  profileSaveStatus.textContent = "";
  profileSaveStatus.classList.remove("error");
  if (currentUser) {
    renderProfileHeader(currentUser.name, currentUser.email);
    // Show what we already know while the full profile loads.
    profileNameInput.value = currentUser.name || "";
    document.getElementById("profileEmailInput").value = currentUser.email;
  }
  try {
    const response = await fetch("/api/profile");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Couldn't load your profile. Please try again in a moment.");
    }
    const p = data.profile;
    renderProfileHeader(p.name, p.email);
    document.getElementById("profileVerified").classList.toggle("hidden", !p.email_verified);
    profileNameInput.value = p.name || "";
    document.getElementById("profileEmailInput").value = p.email;
    document.getElementById("profileJoined").value = formatJoined(p.created_at);
    document.getElementById("statConversations").textContent = p.stats.conversations.toLocaleString();
    document.getElementById("statMessages").textContent = p.stats.messages.toLocaleString();
    document.getElementById("statFiles").textContent = p.stats.files.toLocaleString();
  } catch (error) {
    profileSaveStatus.textContent = error.message;
    profileSaveStatus.classList.add("error");
  }
}

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = profileForm.querySelector("button[type=submit]");
  submit.disabled = true;
  profileSaveStatus.classList.remove("error");
  profileSaveStatus.textContent = "Saving…";
  try {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: profileNameInput.value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not save changes");
    updateUserUI({ ...currentUser, name: data.user.name });
    renderProfileHeader(data.user.name, currentUser.email);
    profileSaveStatus.textContent = "Saved";
  } catch (error) {
    profileSaveStatus.textContent = error.message;
    profileSaveStatus.classList.add("error");
  } finally {
    submit.disabled = false;
  }
});


// ============================
// SETTINGS
// ============================

document.getElementById("settingsThemeBtn").addEventListener("click", () => themeToggle.click());


// ============================
// ACCOUNT ACTIONS (deactivate / delete), confirmed with the password
// ============================

const accountDialog = document.getElementById("accountDialog");
const accountDialogForm = document.getElementById("accountDialogForm");
const accountDialogPassword = document.getElementById("accountDialogPassword");
const accountDialogError = document.getElementById("accountDialogError");
const accountDialogConfirm = document.getElementById("accountDialogConfirm");

const ACCOUNT_ACTIONS = {
  deactivate: {
    title: "Deactivate your account?",
    text: "You'll be signed out on every device and your account will be hidden. Your chats and files are kept. Sign in again any time to reactivate it.",
    confirm: "Deactivate",
    request: (password) => fetch("/api/account/deactivate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    }),
    done: "Your account has been deactivated. Sign in again any time to reactivate it."
  },
  delete: {
    title: "Delete your account?",
    text: "This permanently deletes your account, all your chats and every file you uploaded. It can't be undone.",
    confirm: "Delete account",
    request: (password) => fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    }),
    done: "Your account and all of its chats and files have been deleted."
  }
};

let pendingAccountAction = null;

function openAccountDialog(actionName) {
  const action = ACCOUNT_ACTIONS[actionName];
  pendingAccountAction = action;
  accountDialogForm.reset();
  accountDialogError.textContent = "";
  document.getElementById("accountDialogTitle").textContent = action.title;
  document.getElementById("accountDialogText").textContent = action.text;
  accountDialogConfirm.textContent = action.confirm;
  // Always open with the password hidden, even if it was shown last time.
  accountDialogPassword.type = "password";
  const toggle = accountDialogForm.querySelector(".password-toggle");
  toggle.classList.remove("showing");
  toggle.title = "Show password";
  toggle.setAttribute("aria-label", "Show password");
  accountDialog.showModal();
  accountDialogPassword.focus();
}

document.getElementById("deactivateAccountBtn").addEventListener("click", () => openAccountDialog("deactivate"));
document.getElementById("deleteAccountBtn").addEventListener("click", () => openAccountDialog("delete"));
document.getElementById("accountDialogCancel").addEventListener("click", () => accountDialog.close());

accountDialogForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingAccountAction) return;
  const action = pendingAccountAction;
  accountDialogError.textContent = "";
  accountDialogConfirm.disabled = true;
  try {
    const response = await action.request(accountDialogPassword.value);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong");
    accountDialog.close();
    signedOutLocally();
    showAuthSuccess(action.done);
  } catch (error) {
    accountDialogError.textContent = error.message;
  } finally {
    accountDialogConfirm.disabled = false;
  }
});

// Reset the app to the signed-out state (the server has already ended the session).
function signedOutLocally() {
  stopGenerating();
  currentUser = null;
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  conversationList.innerHTML = "";
  showWelcome();
  showView("chat");
  showAuthScreen();
}


// ============================
// SUGGESTIONS
// ============================

document.addEventListener("click", (event) => {
  const suggestion = event.target.closest(".suggestion");
  if (!suggestion) return;
  messageInput.value = suggestion.textContent.trim();
  messageInput.focus();
});


// ============================
// EVENT LISTENERS
// ============================

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!currentRequest) sendMessage();
  }
});

sendBtn.addEventListener("click", () => {
  if (currentRequest) stopGenerating();
  else sendMessage();
});


// ============================
// INIT
// ============================

(function init() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("reset");
  if (token) {
    resetToken = token;
    history.replaceState(null, "", window.location.pathname);
    showAuthScreen();
    showAuthForm("reset");
    return;
  }
  checkAuth();
})();
