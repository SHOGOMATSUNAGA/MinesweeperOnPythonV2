const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.PORT || 4174);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const rooms = new Map();

const CONFIGS = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? roomCode() : code;
}

function token() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function newPlayer(id, playerToken) {
  return {
    id,
    token: playerToken,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    open: [],
    flags: [],
    started: false,
    elapsed: 0,
    finishElapsed: null,
    busted: false,
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    difficulty: room.difficulty,
    config: room.config,
    seed: room.seed,
    firstIndex: room.firstIndex,
    createdAt: room.createdAt,
    version: room.version,
    players: {
      A: room.players.A && { ...room.players.A, token: undefined },
      B: room.players.B && { ...room.players.B, token: undefined },
    },
  };
}

function createRoom(difficulty) {
  const code = roomCode();
  const playerToken = token();
  const selected = CONFIGS[difficulty] ? difficulty : "intermediate";
  const room = {
    code,
    difficulty: selected,
    config: CONFIGS[selected],
    seed: Math.floor(Math.random() * 1_000_000_000),
    firstIndex: null,
    createdAt: Date.now(),
    version: 1,
    players: {
      A: newPlayer("A", playerToken),
      B: null,
    },
  };
  rooms.set(code, room);
  return { room, playerId: "A", token: playerToken };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[ext] || "application/octet-stream";

    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    json(res, 200, { ok: true, rooms: rooms.size });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/room") {
    const body = await readBody(req);
    const created = createRoom(body.difficulty);
    json(res, 200, {
      playerId: created.playerId,
      token: created.token,
      room: publicRoom(created.room),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    const body = await readBody(req);
    const code = String(body.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      json(res, 404, { error: "room not found" });
      return;
    }
    if (room.players.B) {
      json(res, 409, { error: "room is full" });
      return;
    }
    const playerToken = token();
    room.players.B = newPlayer("B", playerToken);
    room.version += 1;
    json(res, 200, { playerId: "B", token: playerToken, room: publicRoom(room) });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/room\/([A-Z0-9]{6})$/);
  if (req.method === "GET" && roomMatch) {
    const room = rooms.get(roomMatch[1]);
    if (!room) {
      json(res, 404, { error: "room not found" });
      return;
    }
    json(res, 200, { room: publicRoom(room) });
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/room\/([A-Z0-9]{6})\/action$/);
  if (req.method === "POST" && actionMatch) {
    const room = rooms.get(actionMatch[1]);
    if (!room) {
      json(res, 404, { error: "room not found" });
      return;
    }

    const body = await readBody(req);
    const player = room.players[body.playerId];
    if (!player || player.token !== body.token) {
      json(res, 403, { error: "bad player token" });
      return;
    }

    if (Number.isInteger(body.firstIndex) && room.firstIndex === null) {
      room.firstIndex = body.firstIndex;
    }

    if (body.snapshot) {
      player.open = Array.isArray(body.snapshot.open) ? body.snapshot.open : player.open;
      player.flags = Array.isArray(body.snapshot.flags) ? body.snapshot.flags : player.flags;
      player.started = Boolean(body.snapshot.started);
      player.elapsed = Number(body.snapshot.elapsed || 0);
      player.finishElapsed = body.snapshot.finishElapsed === null ? null : Number(body.snapshot.finishElapsed);
      player.busted = Boolean(body.snapshot.busted);
    }
    player.lastSeen = Date.now();
    room.version += 1;
    json(res, 200, { room: publicRoom(room) });
    return;
  }

  json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => json(res, 400, { error: error.message }));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}/`);

  console.log(`Mines Duel server: http://127.0.0.1:${PORT}/`);
  for (const address of addresses) console.log(`LAN: ${address}`);
});
