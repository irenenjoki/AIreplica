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
  await fetch("/api/auth/logout", { method: "POST" });
  currentUser = null;
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  localStorage.removeItem("conversation");
  messages.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-icon">✦</div>
      <h2>How can I help you?</h2>
      <p>Ask me anything. I'm a local AI assistant powered by Qwen 2.5 3B.</p>
      <div class="suggestions">
        <button class="suggestion">Explain something to me</button>
        <button class="suggestion">Help me write code</button>
        <button class="suggestion">Help me plan a project</button>
        <button class="suggestion">Give me ideas</button>
      </div>
    </div>
  `;
  showAuthScreen();
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
const welcome = document.getElementById("welcome");
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
    label.textContent = att.uploading ? `Uploading ${att.filename}...` : att.filename;
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
  const pending = { id: null, filename: file.name, uploading: true };
  pendingAttachments.push(pending);
  renderAttachments();

  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Upload failed");

    pending.id = data.file.id;
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
  try {
    const response = await fetch(`/api/conversations/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load conversation");

    activeConversationId = id;
    activeConversationTitle = data.conversation.title;
    saveActiveConversation();
    markActiveConversationInList();

    const historyBuffer = data.messages.map((msg) => ({ role: msg.role, text: msg.content }));
    localStorage.setItem("conversation", JSON.stringify(historyBuffer));

    messages.innerHTML = "";
    data.messages.forEach((msg) => addMessage(msg.role, msg.content, false, msg.attachments || []));

    if (welcome) welcome.style.display = "none";
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

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;

  if (pendingAttachments.some((a) => a.uploading)) {
    alert("Please wait for the attachment to finish uploading.");
    return;
  }

  if (welcome) welcome.style.display = "none";

  const conversation = JSON.parse(localStorage.getItem("conversation") || "[]");
  const attachedNames = pendingAttachments.map((a) => a.filename);
  addMessage("user", message, true, attachedNames);
  messageInput.value = "";
  sendBtn.disabled = true;
  typing.style.display = "flex";

  const aiMessageEl = createStreamingMessage("assistant");
  let fullResponse = "";

  try {
    const body = { message, conversation };
    if (activeConversationId) body.conversationId = activeConversationId;
    if (pendingAttachments.length) body.fileIds = pendingAttachments.map((a) => a.id);
    pendingAttachments = [];
    renderAttachments();

    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
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
        try {
          const json = JSON.parse(line);
          if (json.chunk) {
            if (typing.style.display !== "none") typing.style.display = "none";
            fullResponse += json.chunk;
            appendToStreamingMessage(aiMessageEl, json.chunk);
          }
          if (json.done) {
            if (json.conversationId && !activeConversationId) {
              activeConversationId = json.conversationId;
              saveActiveConversation();
              loadConversations();
            }
            finalizeStreamingMessage(aiMessageEl, "assistant", fullResponse);
          }
        } catch {}
      }
    }
  } catch (error) {
    console.error("Chat error:", error);
    if (fullResponse) {
      finalizeStreamingMessage(aiMessageEl, "assistant", fullResponse);
    } else {
      aiMessageEl.remove();
      addMessage("assistant", `Error: ${error.message}`);
    }
  } finally {
    sendBtn.disabled = false;
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
  avatar.textContent = role === "user" ? "You" : "AI";

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

function finalizeStreamingMessage(messageEl, role, text) {
  if (!text) return;
  const contentEl = messageEl.querySelector(".message-content");
  contentEl.textContent = text;
  saveMessage(role, text);
}


// ============================
// ADD MESSAGE
// ============================

function addMessage(role, text, save = true, attachmentNames = []) {
  const messageElement = document.createElement("div");
  messageElement.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "You" : "AI";

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

  if (save) saveMessage(role, text);
}


// ============================
// SAVE MESSAGE (localStorage buffer for context)
// ============================

function saveMessage(role, text) {
  const conversation = JSON.parse(localStorage.getItem("conversation") || "[]");
  conversation.push({ role, text });
  localStorage.setItem("conversation", JSON.stringify(conversation));
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
      activeConversationId = null;
      activeConversationTitle = null;
      saveActiveConversation();
      localStorage.removeItem("conversation");
      messages.innerHTML = `
        <div id="welcome" class="welcome">
          <div class="welcome-icon">✦</div>
          <h2>How can I help you?</h2>
          <p>Ask me anything. I'm a local AI assistant powered by Qwen 2.5 3B.</p>
          <div class="suggestions">
            <button class="suggestion">Explain something to me</button>
            <button class="suggestion">Help me write code</button>
            <button class="suggestion">Help me plan a project</button>
            <button class="suggestion">Give me ideas</button>
          </div>
        </div>
      `;
    }
    loadConversations();
  } catch (error) {
    console.error("Failed to delete conversation:", error);
  }
}


// ============================
// NEW CHAT
// ============================

newChatBtn.addEventListener("click", () => {
  activeConversationId = null;
  activeConversationTitle = null;
  saveActiveConversation();
  localStorage.removeItem("conversation");
  messages.innerHTML = `
    <div id="welcome" class="welcome">
      <div class="welcome-icon">✦</div>
      <h2>How can I help you?</h2>
      <p>Ask me anything. I'm a local AI assistant powered by Qwen 2.5 3B.</p>
      <div class="suggestions">
        <button class="suggestion">Explain something to me</button>
        <button class="suggestion">Help me write code</button>
        <button class="suggestion">Help me plan a project</button>
        <button class="suggestion">Give me ideas</button>
      </div>
    </div>
  `;
  messageInput.value = "";
  messageInput.focus();
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
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);


// ============================
// INIT
// ============================

checkAuth();