const CONFIGS = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

const els = {
  difficulty: document.querySelector("#difficulty"),
  newMatch: document.querySelector("#newMatch"),
  createRoom: document.querySelector("#createRoom"),
  joinRoom: document.querySelector("#joinRoom"),
  roomCode: document.querySelector("#roomCode"),
  onlineState: document.querySelector("#onlineState"),
  shareUrl: document.querySelector("#shareUrl"),
  matchState: document.querySelector("#matchState"),
  seedLabel: document.querySelector("#seedLabel"),
  timeA: document.querySelector("#timeA"),
  timeB: document.querySelector("#timeB"),
  stateA: document.querySelector("#stateA"),
  stateB: document.querySelector("#stateB"),
  boardA: document.querySelector("#boardA"),
  boardB: document.querySelector("#boardB"),
};

let match;
let rafId;
let online = {
  enabled: false,
  code: null,
  token: null,
  playerId: null,
  pollId: null,
  syncing: false,
};

const LOCAL_COUNTDOWN_MS = 3000;

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function neighbors(index, rows, cols) {
  const row = Math.floor(index / cols);
  const col = index % cols;
  const result = [];
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const nextRow = row + dr;
      const nextCol = col + dc;
      if (nextRow >= 0 && nextRow < rows && nextCol >= 0 && nextCol < cols) {
        result.push(nextRow * cols + nextCol);
      }
    }
  }
  return result;
}

function createBoard(config, seed, safeIndex) {
  const total = config.rows * config.cols;
  const rng = mulberry32(seed + safeIndex * 101);
  const safe = new Set([safeIndex, ...neighbors(safeIndex, config.rows, config.cols)]);
  const candidates = Array.from({ length: total }, (_, index) => index).filter((index) => !safe.has(index));

  for (let i = candidates.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const mines = new Set(candidates.slice(0, config.mines));
  return Array.from({ length: total }, (_, index) => {
    const mine = mines.has(index);
    const count = mine
      ? 0
      : neighbors(index, config.rows, config.cols).filter((neighbor) => mines.has(neighbor)).length;
    return { mine, count };
  });
}

function newPlayer(id) {
  return {
    id,
    board: null,
    generated: false,
    open: new Set(),
    flags: new Set(),
    start: null,
    finish: null,
    finishElapsed: null,
    remoteElapsed: 0,
    busted: false,
    connected: id === "A",
  };
}

function startMatch(roomState) {
  const config = roomState?.config || CONFIGS[els.difficulty.value];
  const seed = roomState?.seed ?? Math.floor(Math.random() * 1_000_000_000);
  match = {
    config,
    seed,
    sharedBoard: null,
    firstIndex: roomState?.firstIndex ?? null,
    startAt: roomState?.startAt ?? Date.now() + LOCAL_COUNTDOWN_MS,
    revealed: Boolean(roomState?.revealed),
    players: {
      A: newPlayer("A"),
      B: newPlayer("B"),
    },
  };
  if (!online.enabled) {
    match.players.A.connected = true;
    match.players.B.connected = true;
  }
  if (match.firstIndex !== null) ensureGenerated(match.firstIndex);
  if (roomState) applyRoomState(roomState);
  els.seedLabel.textContent = `Seed: ${seed}`;
  renderAll();
  tick();
}

function renderAll() {
  renderPlayer("A");
  renderPlayer("B");
  updateStatus();
}

function canControl(id) {
  return (!online.enabled || online.playerId === id) && isMatchLive();
}

function isMatchLive() {
  return Boolean(match?.startAt) && Date.now() >= match.startAt;
}

function countdownSeconds() {
  return Math.max(0, Math.ceil((match.startAt - Date.now()) / 1000));
}

function renderPlayer(id) {
  const player = match.players[id];
  const boardEl = id === "A" ? els.boardA : els.boardB;
  const hiddenOpponent = online.enabled && !match.revealed && id !== online.playerId;
  boardEl.style.setProperty("--cols", match.config.cols);
  boardEl.classList.toggle("concealed", hiddenOpponent);
  boardEl.innerHTML = "";

  const total = match.config.rows * match.config.cols;
  for (let index = 0; index < total; index += 1) {
    const button = document.createElement("button");
    button.className = "cell";
    button.type = "button";
    button.dataset.index = index;
    button.setAttribute("aria-label", `cell ${index + 1}`);

    const isOpen = !hiddenOpponent && player.open.has(index);
    const isFlag = !hiddenOpponent && player.flags.has(index);
    const cell = player.board?.[index];

    if (isOpen) {
      button.classList.add("open");
      button.disabled = true;
      if (cell?.mine) {
        button.classList.add("mine");
        button.textContent = "*";
      } else if (cell?.count) {
        button.classList.add(`n${cell.count}`);
        button.textContent = cell.count;
      }
    } else if (isFlag) {
      button.classList.add("flag");
      button.textContent = "!";
    }

    if (hiddenOpponent || !canControl(id) || player.finish || player.busted) {
      button.disabled = true;
    }

    button.addEventListener("click", () => openCell(id, index));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleFlag(id, index);
    });
    boardEl.append(button);
  }
}

function ensureGenerated(firstIndex) {
  if (!match.sharedBoard) {
    match.firstIndex = firstIndex;
    match.sharedBoard = createBoard(match.config, match.seed, firstIndex);
  }

  for (const player of Object.values(match.players)) {
    player.board = match.sharedBoard;
    player.generated = true;
  }
}

async function openCell(id, index) {
  const player = match.players[id];
  if (!canControl(id) || player.finish || player.busted || player.flags.has(index)) return;

  if (online.enabled && match.firstIndex === null) {
    const room = await sendSnapshot(index);
    applyRoomState(room);
  }

  ensureGenerated(match.firstIndex ?? index);
  if (!player.start) player.start = performance.now();

  const cell = player.board[index];
  if (cell.mine) {
    player.remoteElapsed = elapsed(player);
    player.busted = true;
    player.open.add(index);
    renderPlayer(id);
    updateStatus();
    await sendSnapshot();
    return;
  }

  floodOpen(player, index);
  checkWin(player);
  renderPlayer(id);
  updateStatus();
  await sendSnapshot();
}

function floodOpen(player, startIndex) {
  const queue = [startIndex];
  while (queue.length) {
    const index = queue.shift();
    if (player.open.has(index) || player.flags.has(index)) continue;
    player.open.add(index);
    const cell = player.board[index];
    if (cell.count !== 0) continue;
    for (const neighbor of neighbors(index, match.config.rows, match.config.cols)) {
      if (!player.open.has(neighbor)) queue.push(neighbor);
    }
  }
}

async function toggleFlag(id, index) {
  const player = match.players[id];
  if (!canControl(id) || player.finish || player.busted || player.open.has(index)) return;
  if (player.flags.has(index)) {
    player.flags.delete(index);
  } else {
    player.flags.add(index);
  }
  renderPlayer(id);
  await sendSnapshot();
}

function checkWin(player) {
  const safeCells = match.config.rows * match.config.cols - match.config.mines;
  if (player.open.size >= safeCells) {
    player.finish = performance.now();
    player.finishElapsed = elapsed(player);
  }
}

function retryPlayer(id) {
  if (!canControl(id)) return;
  const previousPlayer = match.players[id];
  const carriedElapsed = elapsed(previousPlayer);
  const oldBoard = match.sharedBoard;
  const retriedPlayer = newPlayer(id);
  retriedPlayer.board = oldBoard;
  retriedPlayer.generated = Boolean(oldBoard);

  // A retry gives the player a fresh board, but never erases time already used.
  if (previousPlayer.start || carriedElapsed > 0) {
    retriedPlayer.remoteElapsed = carriedElapsed;
    retriedPlayer.start = performance.now() - carriedElapsed * 1000;
  }

  match.players[id] = retriedPlayer;
  renderPlayer(id);
  updateStatus();
  sendSnapshot();
}

function elapsed(player) {
  if (player.finishElapsed !== null) return player.finishElapsed;
  if (player.busted) return player.remoteElapsed || 0;
  if (isMatchLive() && player.connected) return Math.max(0, (Date.now() - match.startAt) / 1000);
  if (!player.start) return player.remoteElapsed || 0;
  return ((player.finish || performance.now()) - player.start) / 1000;
}

function formatTime(value) {
  return `${value.toFixed(1)}s`;
}

function updateStatus() {
  for (const id of ["A", "B"]) {
    const player = match.players[id];
    const timeEl = id === "A" ? els.timeA : els.timeB;
    const stateEl = id === "A" ? els.stateA : els.stateB;
    const hiddenOpponent = online.enabled && !match.revealed && id !== online.playerId;
    timeEl.textContent = formatTime(elapsed(player));
    stateEl.className = "";

    if (!player.connected) {
      stateEl.textContent = "Waiting";
    } else if (!match.startAt) {
      stateEl.textContent = "Waiting for opponent";
    } else if (!isMatchLive()) {
      stateEl.textContent = `Starting in ${countdownSeconds()}`;
    } else if (hiddenOpponent) {
      stateEl.textContent = "Hidden until finish";
    } else if (player.finish) {
      stateEl.textContent = "Finished";
      stateEl.classList.add("winner");
    } else if (player.busted) {
      stateEl.textContent = "Mine hit";
      stateEl.classList.add("busted");
    } else if (isMatchLive()) {
      stateEl.textContent = "Solving";
    } else {
      stateEl.textContent = "Ready";
    }
  }

  const a = match.players.A;
  const b = match.players.B;
  if (!match.startAt) {
    els.matchState.textContent = "Waiting for opponent";
  } else if (!isMatchLive()) {
    els.matchState.textContent = `Starting in ${countdownSeconds()}`;
  } else if (a.finish && b.finish) {
    const winner = elapsed(a) <= elapsed(b) ? "A" : "B";
    els.matchState.textContent = `Player ${winner} wins`;
  } else if ((a.finish && b.busted) || (a.finish && b.connected)) {
    els.matchState.textContent = "Player A leads";
  } else if ((b.finish && a.busted) || (b.finish && a.connected)) {
    els.matchState.textContent = "Player B leads";
  } else if (a.busted && b.busted) {
    els.matchState.textContent = "Both busted";
  } else if (isMatchLive()) {
    els.matchState.textContent = "Live";
  } else {
    els.matchState.textContent = online.enabled ? "Waiting for start" : "Ready";
  }
}

function tick() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    updateStatus();
    rafId = requestAnimationFrame(loop);
  };
  loop();
}

function playerSnapshot(player) {
  return {
    open: [...player.open],
    flags: [...player.flags],
    started: isMatchLive(),
    elapsed: elapsed(player),
    finishElapsed: player.finishElapsed,
    busted: player.busted,
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(online.enabled ? {
        "x-player-id": online.playerId,
        "x-player-token": online.token,
      } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "request failed");
  return data;
}

async function createRoom() {
  const data = await api("/api/room", {
    method: "POST",
    body: JSON.stringify({ difficulty: els.difficulty.value }),
  });
  enterOnline(data);
}

async function joinRoom() {
  const code = els.roomCode.value.trim().toUpperCase();
  if (!code) return;
  const data = await api("/api/join", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  enterOnline(data);
}

function enterOnline(data) {
  online.enabled = true;
  online.code = data.room.code;
  online.token = data.token;
  online.playerId = data.playerId;
  els.roomCode.value = data.room.code;
  els.difficulty.value = data.room.difficulty;
  els.difficulty.disabled = true;
  els.onlineState.textContent = `Online room ${data.room.code} / You are Player ${data.playerId}`;
  els.shareUrl.textContent = `Share: ${location.origin}/  Room: ${data.room.code}`;
  startMatch(data.room);
  startPolling();
}

async function sendSnapshot(firstIndex) {
  if (!online.enabled || online.syncing) return null;
  online.syncing = true;
  try {
    const player = match.players[online.playerId];
    const data = await api(`/api/room/${online.code}/action`, {
      method: "POST",
      body: JSON.stringify({
        token: online.token,
        playerId: online.playerId,
        firstIndex,
        snapshot: playerSnapshot(player),
      }),
    });
    applyRoomState(data.room);
    return data.room;
  } catch (error) {
    els.onlineState.textContent = `Online error: ${error.message}`;
    return null;
  } finally {
    online.syncing = false;
  }
}

function applyRemotePlayer(id, remote) {
  const player = match.players[id];
  player.connected = Boolean(remote);
  if (!remote || online.playerId === id) return;

  if (remote.hidden) {
    player.open.clear();
    player.flags.clear();
    player.remoteElapsed = Number(remote.elapsed || 0);
    player.finishElapsed = null;
    player.finish = null;
    player.busted = Boolean(remote.busted);
    player.start = remote.started && !player.busted
      ? performance.now() - player.remoteElapsed * 1000
      : null;
    return;
  }

  player.open = new Set(remote.open || []);
  player.flags = new Set(remote.flags || []);
  player.remoteElapsed = Number(remote.elapsed || 0);
  player.finishElapsed = remote.finishElapsed;
  player.finish = remote.finishElapsed === null ? null : performance.now();
  player.start = remote.started ? performance.now() - player.remoteElapsed * 1000 : null;
  player.busted = Boolean(remote.busted);
}

function applyRoomState(room) {
  if (!room || !match) return;
  match.config = room.config;
  match.seed = room.seed;
  match.firstIndex = room.firstIndex;
  match.startAt = room.startAt;
  match.revealed = Boolean(room.revealed);
  els.seedLabel.textContent = `Seed: ${room.seed}`;

  if (room.firstIndex !== null) ensureGenerated(room.firstIndex);
  applyRemotePlayer("A", room.players.A);
  applyRemotePlayer("B", room.players.B);
  renderAll();
}

function startPolling() {
  clearInterval(online.pollId);
  online.pollId = setInterval(async () => {
    if (!online.enabled || online.syncing) return;
    try {
      const data = await api(`/api/room/${online.code}`);
      applyRoomState(data.room);
    } catch (error) {
      els.onlineState.textContent = `Online error: ${error.message}`;
    }
  }, 700);
}

els.newMatch.addEventListener("click", () => {
  if (online.enabled) {
    els.onlineState.textContent = "別端末対戦中は新しい部屋を作ると新規試合になります";
    createRoom();
  } else {
    startMatch();
  }
});
els.createRoom.addEventListener("click", createRoom);
els.joinRoom.addEventListener("click", joinRoom);
els.roomCode.addEventListener("input", () => {
  els.roomCode.value = els.roomCode.value.toUpperCase();
});
els.roomCode.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});
els.difficulty.addEventListener("change", () => {
  if (!online.enabled) startMatch();
});
document.querySelectorAll("[data-reset]").forEach((button) => {
  button.addEventListener("click", () => retryPlayer(button.dataset.reset));
});

startMatch();
