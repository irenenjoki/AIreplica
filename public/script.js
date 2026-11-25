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
  showApp();
  await loadActiveConversation();
  loadConversations();
  return true;
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

showRegister.addEventListener("click", () => {
  loginForm.classList.add("hidden");
  registerForm.classList.remove("hidden");
  hideAuthError();
});

showLogin.addEventListener("click", () => {
  registerForm.classList.add("hidden");
  loginForm.classList.remove("hidden");
  hideAuthError();
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
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  markActiveConversationInList();
  showWelcome();
  messageInput.value = "";
  messageInput.focus();
});


// ============================
// DELETE ACCOUNT
// ============================

const deleteAccountBtn = document.getElementById("deleteAccountBtn");
const deleteAccountDialog = document.getElementById("deleteAccountDialog");
const deleteAccountForm = document.getElementById("deleteAccountForm");
const deleteAccountPassword = document.getElementById("deleteAccountPassword");
const deleteAccountError = document.getElementById("deleteAccountError");

deleteAccountBtn.addEventListener("click", () => {
  deleteAccountForm.reset();
  // Always open with the password hidden, even if it was shown last time.
  deleteAccountPassword.type = "password";
  const toggle = deleteAccountForm.querySelector(".password-toggle");
  toggle.classList.remove("showing");
  toggle.title = "Show password";
  toggle.setAttribute("aria-label", "Show password");
  deleteAccountError.textContent = "";
  deleteAccountDialog.showModal();
  deleteAccountPassword.focus();
});

document.getElementById("deleteAccountCancel").addEventListener("click", () => deleteAccountDialog.close());

deleteAccountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  deleteAccountError.textContent = "";
  const submit = deleteAccountForm.querySelector(".toast-confirm");
  submit.disabled = true;
  try {
    const response = await fetch("/api/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: deleteAccountPassword.value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not delete account");
    deleteAccountDialog.close();
    stopGenerating();
    currentUser = null;
    activeConversationId = null;
    activeConversationTitle = null;
    saveActiveConversation();
    conversationList.innerHTML = "";
    showWelcome();
    showAuthScreen();
    showAuthSuccess("Your account and all of its chats and files have been deleted.");
  } catch (error) {
    deleteAccountError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});


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

checkAuth();
