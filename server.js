const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");
const { createStorage } = require("./storage");
const { getTrackEdges } = require("./public/track-geometry");

const PORT = Number(process.env.PORT) || 3000;
const TOTAL_LAPS = 3;
const MAX_PLAYERS = 8;
const STEERING_RADIUS = 7;
const STEERING_RESPONSE = 8.5;
const CAR_COLLISION_RADIUS = 1.6;
const MAX_REVERSE_SPEED = 5;
const REVERSE_ACCELERATION = 7;
const DEFAULT_TRACK_ID = "monaco";
const BOT_NAMES = ["Chispa", "Turbo", "Pistón", "Rayo", "Choco", "Nube", "Trueno"];
const CAR_COLORS = ["#30d6c1", "#ffb94b", "#ff6978", "#8a7cff", "#d9ed63", "#54a9ff", "#ff8ccc", "#f7f3e8"];
const TRACKS = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "tracks.json"), "utf8"));
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "catalog.json"), "utf8"));
const CATALOG_BY_ID = new Map(CATALOG.items.map((item) => [item.id, item]));
const COSMETIC_CATEGORIES = ["color", "camo", "wheels", "helmet", "spoiler", "trail"];
const BASE_RACE_POINTS = [100, 70, 50, 35, 25, 20, 15, 10];
const BASE_RACE_COINS = [120, 85, 60, 45, 35, 30, 25, 20];

function prepareTrack(track) {
  const points = [
    ...track.points.slice(track.startIndex),
    ...track.points.slice(0, track.startIndex),
  ];
  const edgeProfile = getTrackEdges({ ...track, points });
  const segments = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next[0] - point[0];
    const dz = next[1] - point[1];
    return {
      x: point[0],
      z: point[1],
      dx,
      dz,
      length: Math.hypot(dx, dz),
      widthStart: edgeProfile[index].width,
      widthEnd: edgeProfile[(index + 1) % points.length].width,
    };
  });
  let length = 0;
  for (const segment of segments) {
    segment.start = length;
    length += segment.length;
  }
  return { ...track, points, segments, length };
}

const PREPARED_TRACKS = Object.fromEntries(
  Object.entries(TRACKS).map(([id, track]) => [id, prepareTrack(track)])
);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getLanAddresses() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function getFinishTiming(cars, raceStartedAt) {
  const finishers = [...cars]
    .filter((car) => car.finishedAt !== null)
    .sort((a, b) => a.finishedAt - b.finishedAt);
  const firstFinisher = finishers[0];
  if (!firstFinisher) return new Map();

  return new Map(finishers.map((car) => [car.id, {
    isFirstFinisher: car.id === firstFinisher.id,
    finishTimeMs: Math.max(0, car.finishedAt - raceStartedAt),
    gapMs: Math.max(0, car.finishedAt - firstFinisher.finishedAt),
  }]));
}

function getCrossingTimeMs(previousProgress, currentProgress, finishProgress, tickEndTime, tickDuration) {
  const progressDelta = currentProgress - previousProgress;
  if (progressDelta <= 0) return tickEndTime;
  const crossing = clamp((finishProgress - previousProgress) / progressDelta, 0, 1);
  return tickEndTime - (1 - crossing) * tickDuration * 1000;
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function areHumanDriversFinished(cars) {
  const humans = [...cars].filter((car) => !car.isBot);
  return humans.length > 0 && humans.every((car) => car.finishedAt !== null);
}

function constrainCarToMap(car, track) {
  const inside = Math.abs(car.x) <= track.bounds && Math.abs(car.z) <= track.bounds;
  if (!inside) {
    car.x = clamp(car.x, -track.bounds, track.bounds);
    car.z = clamp(car.z, -track.bounds, track.bounds);
    car.speed = 0;
  }
  return inside;
}

function constrainCarToTrack(car, track) {
  const projection = projectToTrack(track, car.x, car.z);
  const trackWidth = Number.isFinite(projection.width) ? projection.width : track.width;
  const maxOffset = Math.max(0, trackWidth / 2 - CAR_COLLISION_RADIUS * 0.7);
  const distance = Math.sqrt(projection.distanceSquared);
  if (distance > maxOffset) {
    const scale = maxOffset / distance;
    car.x = projection.x + (car.x - projection.x) * scale;
    car.z = projection.z + (car.z - projection.z) * scale;
    car.speed *= 0.35;
  }
  return projection;
}

function resolveCarCollisions(cars) {
  const activeCars = [...cars].filter((car) => car.finishedAt === null);
  const minimumDistance = CAR_COLLISION_RADIUS * 2;
  for (let firstIndex = 0; firstIndex < activeCars.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < activeCars.length; secondIndex += 1) {
      const first = activeCars[firstIndex];
      const second = activeCars[secondIndex];
      let dx = second.x - first.x;
      let dz = second.z - first.z;
      let distance = Math.hypot(dx, dz);
      if (distance >= minimumDistance) continue;
      if (distance < 1e-6) {
        dx = first.id.localeCompare(second.id) < 0 ? 1 : -1;
        dz = 0;
        distance = 1;
      }

      const normalX = dx / distance;
      const normalZ = dz / distance;
      const overlap = minimumDistance - distance;
      first.x -= normalX * overlap / 2;
      first.z -= normalZ * overlap / 2;
      second.x += normalX * overlap / 2;
      second.z += normalZ * overlap / 2;

      const firstVelocityX = -Math.sin(first.yaw) * first.speed;
      const firstVelocityZ = -Math.cos(first.yaw) * first.speed;
      const secondVelocityX = -Math.sin(second.yaw) * second.speed;
      const secondVelocityZ = -Math.cos(second.yaw) * second.speed;
      const relativeSpeed = (secondVelocityX - firstVelocityX) * normalX
        + (secondVelocityZ - firstVelocityZ) * normalZ;
      if (relativeSpeed >= 0) continue;

      const impulse = -(1.25 * relativeSpeed) / 2;
      const firstAfterX = firstVelocityX - impulse * normalX;
      const firstAfterZ = firstVelocityZ - impulse * normalZ;
      const secondAfterX = secondVelocityX + impulse * normalX;
      const secondAfterZ = secondVelocityZ + impulse * normalZ;
      first.speed = Math.hypot(firstAfterX, firstAfterZ);
      second.speed = Math.hypot(secondAfterX, secondAfterZ);
      if (first.speed > 0.1) first.yaw = Math.atan2(-firstAfterX, -firstAfterZ);
      if (second.speed > 0.1) second.yaw = Math.atan2(-secondAfterX, -secondAfterZ);
    }
  }
}

function getTrackPosition(track, distance) {
  const wrappedDistance = (distance % track.length + track.length) % track.length;
  const segment = track.segments.find((entry) => wrappedDistance <= entry.start + entry.length)
    || track.segments[track.segments.length - 1];
  const fraction = (wrappedDistance - segment.start) / segment.length;
  return {
    x: segment.x + segment.dx * fraction,
    z: segment.z + segment.dz * fraction,
    tangentX: segment.dx / segment.length,
    tangentZ: segment.dz / segment.length,
    distance: wrappedDistance,
    segmentIndex: track.segments.indexOf(segment),
    fraction,
    width: Number.isFinite(segment.widthStart)
      ? segment.widthStart + (segment.widthEnd - segment.widthStart) * fraction
      : track.width,
  };
}

function projectToTrack(track, x, z) {
  let nearest = null;
  for (let segmentIndex = 0; segmentIndex < track.segments.length; segmentIndex += 1) {
    const segment = track.segments[segmentIndex];
    const fraction = clamp(
      ((x - segment.x) * segment.dx + (z - segment.z) * segment.dz) / (segment.length ** 2),
      0,
      1
    );
    const projectedX = segment.x + segment.dx * fraction;
    const projectedZ = segment.z + segment.dz * fraction;
    const distanceSquared = (x - projectedX) ** 2 + (z - projectedZ) ** 2;
    if (!nearest || distanceSquared < nearest.distanceSquared) {
      nearest = {
        distance: segment.start + segment.length * fraction,
        distanceSquared,
        x: projectedX,
        z: projectedZ,
        segmentIndex,
        fraction,
        width: Number.isFinite(segment.widthStart)
          ? segment.widthStart + (segment.widthEnd - segment.widthStart) * fraction
          : track.width,
      };
    }
  }
  return nearest;
}

function calculateRaceRewards({
  place,
  entrantCount,
  lapsCompleted,
  totalLaps = TOTAL_LAPS,
  bestLapMs = null,
  fastestLapMs = null,
}) {
  const rivals = Math.max(0, entrantCount - 1);
  const multiplier = rivals === 0 ? 0 : Math.min(1, 0.6 + (rivals - 1) * 0.2);
  const positionIndex = clamp(place - 1, 0, BASE_RACE_POINTS.length - 1);
  const basePoints = Math.floor(BASE_RACE_POINTS[positionIndex] * multiplier);
  const baseCoins = Math.floor(BASE_RACE_COINS[positionIndex] * multiplier);
  const completedBonus = lapsCompleted >= totalLaps;
  const fastestLapBonus = Number.isFinite(bestLapMs) && bestLapMs === fastestLapMs;
  const completionPoints = completedBonus ? Math.floor(25 * multiplier) : 0;
  const completionCoins = completedBonus ? Math.floor(25 * multiplier) : 0;
  const fastestLapPoints = fastestLapBonus ? Math.floor(35 * multiplier) : 0;
  const fastestLapCoins = fastestLapBonus ? Math.floor(30 * multiplier) : 0;
  return {
    place,
    rivals,
    basePoints,
    completionPoints,
    fastestLapPoints,
    points: basePoints + completionPoints + fastestLapPoints,
    baseCoins,
    completionCoins,
    fastestLapCoins,
    coins: baseCoins + completionCoins + fastestLapCoins,
    completedBonus,
    fastestLapBonus,
  };
}

function settleRaceOnce(settlement, award) {
  if (settlement.rewarded) return false;
  settlement.rewarded = true;
  award();
  return true;
}

function createGameServer(options = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const storage = createStorage(
    options.dataDir || path.join(__dirname, "data"),
    CATALOG
  );
  const loginAttempts = new Map();
  const cars = new Map();
  let hostId = null;
  let phase = "lobby";
  let raceSettings = { maxPlayers: MAX_PLAYERS, botsEnabled: false, trackId: DEFAULT_TRACK_ID };
  let nextBotId = 1;
  let countdownEndsAt = 0;
  let raceStartedAt = 0;
  let raceEntrantCount = 0;
  const raceSettlement = { rewarded: false };
  let lastTick = Date.now();
  let lastBroadcastAt = lastTick;

  app.use(express.json({ limit: "16kb" }));
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/vendor/three.module.js", (req, res) => {
    res.sendFile(path.join(__dirname, "node_modules", "three", "build", "three.module.js"));
  });
  app.get("/api/info", (req, res) => {
    const port = httpServer.address()?.port || PORT;
    res.json({
      lanUrls: getLanAddresses().map((address) => `http://${address}:${port}`),
    });
  });
  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.get("/api/leaderboard", (req, res) => {
    res.json(storage.leaderboard());
  });

  function getBearerToken(req) {
    const [scheme, token] = String(req.get("authorization") || "").split(" ");
    return scheme?.toLowerCase() === "bearer" ? token : null;
  }

  function requireAccount(req, res) {
    const account = storage.getSession(getBearerToken(req));
    if (!account) {
      res.status(401).json({ error: "Inicia sesión para continuar." });
      return null;
    }
    return account;
  }

  function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  app.post("/api/register", asyncRoute(async (req, res) => {
    const result = await storage.register(req.body?.username, req.body?.password);
    res.status(201).json(result);
  }));
  app.post("/api/login", asyncRoute(async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempt = loginAttempts.get(clientIp);
    const currentAttempt = !attempt || now - attempt.windowStartedAt >= 60_000
      ? { count: 0, windowStartedAt: now }
      : attempt;
    if (currentAttempt.count >= 8) {
      res.status(429).json({ error: "Demasiados intentos. Espera un minuto antes de volver a intentarlo." });
      return;
    }
    try {
      const result = await storage.login(req.body?.username, req.body?.password);
      loginAttempts.delete(clientIp);
      res.json(result);
    } catch (error) {
      if (error.status === 401) {
        currentAttempt.count += 1;
        loginAttempts.set(clientIp, currentAttempt);
      }
      throw error;
    }
  }));
  app.post("/api/logout", (req, res) => {
    const token = getBearerToken(req);
    const account = storage.getSession(token);
    storage.logout(token);
    if (account) {
      for (const [socketId, car] of cars) {
        if (car.accountToken !== token) continue;
        io.sockets.sockets.get(socketId)?.disconnect(true);
      }
    }
    res.status(204).end();
  });
  app.get("/api/me", (req, res) => {
    const account = requireAccount(req, res);
    if (account) res.json(storage.publicProfile(account));
  });
  app.post("/api/shop/buy", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const item = CATALOG_BY_ID.get(String(req.body?.itemId || ""));
    if (!item) {
      res.status(404).json({ error: "El artículo no existe." });
      return;
    }
    const result = storage.buyItem(account.username, item);
    res.status(result.status || 200).json(result.ok ? result.profile : { error: result.error });
  });
  app.post("/api/inventory/equip", (req, res) => {
    const account = requireAccount(req, res);
    if (!account) return;
    const category = String(req.body?.category || "");
    const item = CATALOG_BY_ID.get(String(req.body?.itemId || ""));
    if (!COSMETIC_CATEGORIES.includes(category) || !item || item.category !== category) {
      res.status(400).json({ error: "La categoría o el artículo no son válidos." });
      return;
    }
    const result = storage.equipItem(account.username, category, item);
    res.status(result.status || 200).json(result.ok ? result.profile : { error: result.error });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (!error.status || error.status >= 500) console.error("Error en el endpoint HTTP.", error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "No se pudo completar la operación.",
    });
  });

  function normalizeCosmetics(cosmetics) {
    return Object.fromEntries(COSMETIC_CATEGORIES.map((category) => {
      const item = CATALOG_BY_ID.get(cosmetics?.[category]);
      return [category, item?.category === category ? item.id : CATALOG.defaults[category]];
    }));
  }

  function randomBotCosmetics(seed) {
    return Object.fromEntries(COSMETIC_CATEGORIES.map((category, categoryIndex) => {
      const options = CATALOG.items.filter((item) => item.category === category);
      return [category, options[(seed + categoryIndex * 3) % options.length].id];
    }));
  }

  function makeCar({ id, name, color, isBot = false, cosmetics, accountUsername, accountToken }) {
    const track = PREPARED_TRACKS[raceSettings.trackId];
    const gridIndex = cars.size;
    const startDistance = 4 + Math.floor(gridIndex / 2) * 4.5;
    const gridPosition = getTrackPosition(track, track.length - startDistance);
    const maxLaneOffset = Math.max(0, gridPosition.width / 2 - CAR_COLLISION_RADIUS * 0.7);
    const laneOffset = (gridIndex % 2 === 0 ? -1 : 1)
      * Math.min(gridPosition.width * 0.25, 2.2, maxLaneOffset);
    const normalX = -gridPosition.tangentZ;
    const normalZ = gridPosition.tangentX;
    const appearance = normalizeCosmetics(cosmetics || {});
    if (!cosmetics && color) {
      const matchingColor = CATALOG.items.find((item) => item.category === "color" && item.color === color);
      if (matchingColor) appearance.color = matchingColor.id;
    }
    if (isBot && !cosmetics) Object.assign(appearance, randomBotCosmetics(gridIndex));
    const selectedColor = CATALOG_BY_ID.get(appearance.color);
    return {
      id,
      name,
      color: accountUsername || isBot ? selectedColor.color : color || selectedColor.color,
      isBot,
      accountUsername: accountUsername || null,
      accountToken: accountToken || null,
      cosmetics: appearance,
      x: gridPosition.x + normalX * laneOffset,
      z: gridPosition.z + normalZ * laneOffset,
      yaw: Math.atan2(-gridPosition.tangentX, -gridPosition.tangentZ),
      speed: 0,
      steering: 0,
      input: { throttle: 0, brake: 0, steer: 0 },
      lastTrackDistance: gridPosition.distance,
      progress: 0,
      lapsCompleted: 0,
      finishProgress: TOTAL_LAPS * track.length + startDistance,
      lapStartedAt: 0,
      lapTimesMs: [],
      bestLapMs: null,
      finishedAt: null,
      reward: null,
    };
  }

  function syncBots() {
    const humans = [...cars.values()].filter((car) => !car.isBot).length;
    const targetBots = raceSettings.botsEnabled ? raceSettings.maxPlayers - humans : 0;
    const existingBots = [...cars.values()].filter((car) => car.isBot);
    while (existingBots.length > targetBots) {
      cars.delete(existingBots.pop().id);
    }
    while (existingBots.length < targetBots) {
      const index = nextBotId++;
      const name = BOT_NAMES[(index - 1) % BOT_NAMES.length];
      const id = `bot-${index}`;
      const bot = makeCar({
        id,
        name,
        color: CAR_COLORS[index % CAR_COLORS.length],
        isBot: true,
      });
      cars.set(id, bot);
      existingBots.push(bot);
    }
  }

  function regridLobbyCars() {
    const existingCars = [...cars.values()];
    cars.clear();
    for (const car of existingCars) cars.set(car.id, makeCar(car));
  }

  function getStandings() {
    return [...cars.values()].sort((a, b) => {
      if (a.finishedAt !== null || b.finishedAt !== null) {
        if (a.finishedAt === null) return 1;
        if (b.finishedAt === null) return -1;
        return a.finishedAt - b.finishedAt;
      }
      return b.progress - a.progress;
    });
  }

  function settleRace(now) {
    settleRaceOnce(raceSettlement, () => {
      phase = "finished";
      const standings = getStandings();
      const lapTimes = standings.flatMap((car) => car.lapTimesMs);
      const fastestLapMs = lapTimes.length ? Math.min(...lapTimes) : null;
      standings.forEach((car, index) => {
        if (car.isBot) return;
        car.reward = calculateRaceRewards({
          place: index + 1,
          entrantCount: raceEntrantCount,
          lapsCompleted: car.lapsCompleted,
          bestLapMs: car.bestLapMs,
          fastestLapMs,
        });
        if (car.accountUsername) {
          try {
            storage.recordRace(car.accountUsername, {
              ...car.reward,
              bestLapMs: car.bestLapMs,
            });
          } catch (error) {
            console.error(`No se pudo guardar la recompensa de ${car.accountUsername}.`, error);
            car.reward.persistenceError = true;
          }
        }
      });
      if (raceStartedAt === 0) raceStartedAt = now;
    });
  }

  function createSnapshot(now = Date.now()) {
    const standings = getStandings();
    const finishTiming = getFinishTiming(cars.values(), raceStartedAt);
    const raceEndAt = phase === "finished"
      ? Math.max(...standings.map((car) => car.finishedAt || 0))
      : now;
    return {
      phase,
      hostId,
      totalLaps: TOTAL_LAPS,
      track: {
        ...TRACKS[raceSettings.trackId],
        points: PREPARED_TRACKS[raceSettings.trackId].points,
      },
      maxPlayers: raceSettings.maxPlayers,
      botsEnabled: raceSettings.botsEnabled,
      raceElapsedMs: raceStartedAt > 0 && (phase === "racing" || phase === "finished")
        ? Math.max(0, raceEndAt - raceStartedAt)
        : 0,
      countdown: phase === "countdown" ? Math.max(0, Math.ceil((countdownEndsAt - now) / 1000)) : 0,
      cars: standings.map((car, index) => ({
        id: car.id,
        name: car.name,
        color: car.color,
        cosmetics: { ...car.cosmetics },
        isBot: car.isBot,
        x: car.x,
        z: car.z,
        yaw: car.yaw,
        speed: car.speed,
        steering: car.steering,
        accelerating: car.input.throttle > 0,
        braking: car.input.brake > 0 || car.speed < -0.1,
        lap: Math.min(TOTAL_LAPS, car.lapsCompleted + 1),
        progress: car.progress,
        finished: car.finishedAt !== null,
        bestLapMs: car.bestLapMs,
        reward: car.reward ? { ...car.reward } : null,
        ...(finishTiming.get(car.id) || {
          isFirstFinisher: false,
          finishTimeMs: null,
          gapMs: null,
        }),
        place: index + 1,
      })),
    };
  }

  function broadcastState(now = Date.now()) {
    lastBroadcastAt = now;
    io.emit("raceState", createSnapshot(now));
  }

  function updateCar(car, dt) {
    const track = PREPARED_TRACKS[raceSettings.trackId];
    const projection = projectToTrack(track, car.x, car.z);
    const distanceFromTrack = Math.sqrt(projection.distanceSquared);
    if (car.isBot) {
      const target = getTrackPosition(track, projection.distance + 7);
      const desiredYaw = Math.atan2(-(target.x - car.x), -(target.z - car.z));
      const headingError = wrapAngle(desiredYaw - car.yaw);
      car.input = {
        throttle: 1,
        brake: 0,
        steer: clamp(-headingError * 1.8, -1, 1),
      };
    }

    const onTrack = distanceFromTrack <= projection.width * 0.75;
    const maxSpeed = onTrack ? 18 : 8;
    const acceleration = onTrack ? 11 : 6;
    if (car.input.brake > 0) {
      if (car.speed > 0) {
        car.speed = Math.max(0, car.speed - 18 * car.input.brake * dt);
      } else {
        car.speed = Math.max(-MAX_REVERSE_SPEED, car.speed - REVERSE_ACCELERATION * car.input.brake * dt);
      }
    } else if (car.input.throttle > 0) {
      if (car.speed < 0) {
        car.speed = Math.min(0, car.speed + 18 * car.input.throttle * dt);
      } else {
        car.speed = Math.min(maxSpeed, car.speed + acceleration * car.input.throttle * dt);
      }
    } else if (car.speed > 0) {
      car.speed = Math.max(0, car.speed - 2.8 * dt);
    } else {
      car.speed = Math.min(0, car.speed + 2.8 * dt);
    }

    car.steering += clamp(
      car.input.steer - car.steering,
      -STEERING_RESPONSE * dt,
      STEERING_RESPONSE * dt
    );

    if (Math.abs(car.speed) > 0.1) {
      car.yaw = wrapAngle(car.yaw - (car.speed / STEERING_RADIUS) * car.steering * dt);
      car.x -= Math.sin(car.yaw) * car.speed * dt;
      car.z -= Math.cos(car.yaw) * car.speed * dt;
    }

    constrainCarToMap(car, track);
    const nextProjection = constrainCarToTrack(car, track);
    let distanceDelta = nextProjection.distance - car.lastTrackDistance;
    if (distanceDelta < -track.length / 2) distanceDelta += track.length;
    if (distanceDelta > track.length / 2) distanceDelta -= track.length;
    car.progress = Math.max(0, car.progress + Math.max(0, distanceDelta));
    car.lastTrackDistance = nextProjection.distance;
  }

  const tick = setInterval(() => {
    const now = Date.now();
    let dt = clamp((now - lastTick) / 1000, 0, 0.08);
    lastTick = now;

    if (phase === "countdown" && now >= countdownEndsAt) {
      phase = "racing";
      raceStartedAt = now;
      for (const car of cars.values()) car.lapStartedAt = now;
      dt = 0;
    }
    if (phase === "racing") {
      for (const car of cars.values()) {
        if (car.finishedAt !== null) continue;
        const previousProgress = car.progress;
        updateCar(car, dt);
        const trackLength = PREPARED_TRACKS[raceSettings.trackId].length;
        const completedLaps = Math.min(
          TOTAL_LAPS,
          Math.floor((car.progress + 1e-6) / trackLength)
        );
        if (completedLaps > car.lapsCompleted) {
          const crossingProgress = (car.lapsCompleted + 1) * trackLength;
          const crossingAt = getCrossingTimeMs(previousProgress, car.progress, crossingProgress, now, dt);
          const lapTimeMs = Math.max(0, crossingAt - car.lapStartedAt);
          car.lapTimesMs.push(lapTimeMs);
          car.bestLapMs = car.bestLapMs === null ? lapTimeMs : Math.min(car.bestLapMs, lapTimeMs);
          car.lapStartedAt = crossingAt;
          car.lapsCompleted = completedLaps;
        }
        if (car.progress >= car.finishProgress) {
          car.finishedAt = getCrossingTimeMs(previousProgress, car.progress, car.finishProgress, now, dt);
        }
      }
      resolveCarCollisions(cars.values());
      for (const car of cars.values()) {
        if (car.finishedAt !== null) continue;
        constrainCarToMap(car, PREPARED_TRACKS[raceSettings.trackId]);
        const projection = constrainCarToTrack(car, PREPARED_TRACKS[raceSettings.trackId]);
        car.lastTrackDistance = projection.distance;
      }
      if (areHumanDriversFinished(cars.values())) settleRace(now);
    }
    if (now - lastBroadcastAt >= 100) broadcastState(now);
  }, 50);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || storage.getSession(token)) {
      next();
      return;
    }
    next(new Error("La sesión de la cuenta no es válida."));
  });

  io.on("connection", (socket) => {
    socket.on("joinRace", (payload = {}, acknowledge = () => {}) => {
      const token = payload.token || socket.handshake.auth?.token;
      const account = token ? storage.getSession(token) : null;
      if (token && !account) {
        acknowledge({ ok: false, error: "La sesión de la cuenta ha caducado. Inicia sesión de nuevo." });
        return;
      }
      if (cars.has(socket.id)) {
        acknowledge({ ok: true, id: socket.id });
        return;
      }
      if (
        account
        && [...cars.values()].some((car) => car.accountUsername?.toLowerCase() === account.username.toLowerCase())
      ) {
        acknowledge({ ok: false, error: "Esta cuenta ya está conectada a la sala." });
        return;
      }
      if (phase !== "lobby") {
        acknowledge({ ok: false, error: "La carrera ya ha comenzado. Espera a la siguiente." });
        return;
      }
      const humanCount = [...cars.values()].filter((car) => !car.isBot).length;
      if (humanCount >= raceSettings.maxPlayers) {
        acknowledge({ ok: false, error: "La sala está completa." });
        return;
      }

      const name = account?.username || String(payload.name || "Piloto").trim().slice(0, 16) || "Piloto";
      if (!hostId) {
        const hasNewSettings = payload.maxPlayers !== undefined || payload.botsEnabled !== undefined;
        const legacyBotCount = clamp(Math.round(Number(payload.botCount) || 0), 0, MAX_PLAYERS - 1);
        const requestedMaxPlayers = hasNewSettings
          ? Number(payload.maxPlayers)
          : legacyBotCount + 1;
        const trackId = String(payload.trackId || DEFAULT_TRACK_ID);
        if (!Number.isInteger(requestedMaxPlayers) || requestedMaxPlayers < 1 || requestedMaxPlayers > MAX_PLAYERS) {
          acknowledge({ ok: false, error: "El número de participantes debe estar entre 1 y 8." });
          return;
        }
        if (!PREPARED_TRACKS[trackId]) {
          acknowledge({ ok: false, error: "El circuito seleccionado no está disponible." });
          return;
        }
        raceSettings = {
          maxPlayers: requestedMaxPlayers,
          botsEnabled: hasNewSettings ? payload.botsEnabled === true : legacyBotCount > 0,
          trackId,
        };
      }
      if (hostId && raceSettings.botsEnabled) {
        const replaceableBot = [...cars.values()].find((car) => car.isBot);
        if (replaceableBot) cars.delete(replaceableBot.id);
        regridLobbyCars();
      }
      const human = makeCar({
        id: socket.id,
        name,
        color: CAR_COLORS[humanCount % CAR_COLORS.length],
        cosmetics: account?.equipped,
        accountUsername: account?.username,
        accountToken: token,
      });
      cars.set(socket.id, human);
      if (!hostId) {
        hostId = socket.id;
      }
      syncBots();
      acknowledge({ ok: true, id: socket.id });
      broadcastState();
    });

    socket.on("driverInput", (input = {}) => {
      const car = cars.get(socket.id);
      if (!car || car.isBot || phase !== "racing" || car.finishedAt !== null) return;
      car.input = {
        throttle: clamp(Number(input.throttle) || 0, 0, 1),
        brake: clamp(Number(input.brake) || 0, 0, 1),
        steer: clamp(Number(input.steer) || 0, -1, 1),
      };
    });

    socket.on("startRace", () => {
      if (socket.id !== hostId || phase !== "lobby" || cars.size === 0) return;
      phase = "countdown";
      countdownEndsAt = Date.now() + 3200;
      raceStartedAt = 0;
      raceEntrantCount = cars.size;
      raceSettlement.rewarded = false;
      for (const car of cars.values()) {
        car.lapsCompleted = 0;
        car.lapStartedAt = 0;
        car.lapTimesMs = [];
        car.bestLapMs = null;
        car.reward = null;
      }
      broadcastState();
    });

    socket.on("restartRace", () => {
      if (socket.id !== hostId || phase !== "finished") return;
      const existingCars = [...cars.values()];
      cars.clear();
      for (const car of existingCars) {
        cars.set(car.id, makeCar(car));
      }
      syncBots();
      phase = "lobby";
      countdownEndsAt = 0;
      raceStartedAt = 0;
      raceEntrantCount = 0;
      raceSettlement.rewarded = false;
      broadcastState();
    });

    socket.on("disconnect", () => {
      cars.delete(socket.id);
      const remainingHumans = [...cars.values()].filter((car) => !car.isBot);
      if (remainingHumans.length === 0) {
        cars.clear();
        hostId = null;
        phase = "lobby";
        raceSettings = { maxPlayers: MAX_PLAYERS, botsEnabled: false, trackId: DEFAULT_TRACK_ID };
        nextBotId = 1;
        countdownEndsAt = 0;
        raceStartedAt = 0;
        raceEntrantCount = 0;
        raceSettlement.rewarded = false;
      } else if (hostId === socket.id) {
        hostId = remainingHumans[0].id;
        if (phase === "lobby") {
          regridLobbyCars();
          syncBots();
        }
      } else if (phase === "lobby") {
        regridLobbyCars();
        syncBots();
      }
      broadcastState();
    });
  });

  function close() {
    clearInterval(tick);
    return new Promise((resolve) => io.close(resolve));
  }

  return { app, httpServer, io, close };
}

if (require.main === module) {
  const game = createGameServer();
  game.httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Race2Win disponible en http://localhost:${game.httpServer.address().port}`);
    for (const address of getLanAddresses()) {
      console.log(`Red local: http://${address}:${game.httpServer.address().port}`);
    }
  });
}

module.exports = {
  createGameServer,
  areHumanDriversFinished,
  calculateRaceRewards,
  settleRaceOnce,
  constrainCarToMap,
  constrainCarToTrack,
  getCrossingTimeMs,
  getFinishTiming,
  resolveCarCollisions,
};
