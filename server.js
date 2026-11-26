const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

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

function prepareTrack(track) {
  const points = [
    ...track.points.slice(track.startIndex),
    ...track.points.slice(0, track.startIndex),
  ];
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
  const maxOffset = Math.max(0, track.width / 2 - CAR_COLLISION_RADIUS * 0.7);
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
  };
}

function projectToTrack(track, x, z) {
  let nearest = null;
  for (const segment of track.segments) {
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
      };
    }
  }
  return nearest;
}

function createGameServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const cars = new Map();
  let hostId = null;
  let phase = "lobby";
  let raceSettings = { maxPlayers: MAX_PLAYERS, botsEnabled: false, trackId: DEFAULT_TRACK_ID };
  let nextBotId = 1;
  let countdownEndsAt = 0;
  let raceStartedAt = 0;
  let lastTick = Date.now();
  let lastBroadcastAt = lastTick;

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

  function makeCar({ id, name, color, isBot = false }) {
    const track = PREPARED_TRACKS[raceSettings.trackId];
    const gridIndex = cars.size;
    const startDistance = 4 + Math.floor(gridIndex / 2) * 4.5;
    const gridPosition = getTrackPosition(track, track.length - startDistance);
    const laneOffset = (gridIndex % 2 === 0 ? -1 : 1) * Math.min(track.width * 0.25, 2.2);
    const normalX = -gridPosition.tangentZ;
    const normalZ = gridPosition.tangentX;
    return {
      id,
      name,
      color,
      isBot,
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
      finishedAt: null,
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
        isBot: car.isBot,
        x: car.x,
        z: car.z,
        yaw: car.yaw,
        speed: car.speed,
        lap: Math.min(TOTAL_LAPS, car.lapsCompleted + 1),
        progress: car.progress,
        finished: car.finishedAt !== null,
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

    const onTrack = distanceFromTrack <= track.width * 0.75;
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

    if (car.speed > 0.1) {
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
      dt = 0;
    }
    if (phase === "racing") {
      for (const car of cars.values()) {
        if (car.finishedAt !== null) continue;
        const previousProgress = car.progress;
        updateCar(car, dt);
        car.lapsCompleted = Math.max(
          car.lapsCompleted,
          Math.min(TOTAL_LAPS, Math.floor((car.progress + 1e-6) / PREPARED_TRACKS[raceSettings.trackId].length))
        );
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
      if (areHumanDriversFinished(cars.values())) phase = "finished";
    }
    if (now - lastBroadcastAt >= 100) broadcastState(now);
  }, 50);

  io.on("connection", (socket) => {
    socket.on("joinRace", (payload = {}, acknowledge = () => {}) => {
      if (cars.has(socket.id)) {
        acknowledge({ ok: true, id: socket.id });
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

      const name = String(payload.name || "Piloto").trim().slice(0, 16) || "Piloto";
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
  constrainCarToMap,
  constrainCarToTrack,
  getCrossingTimeMs,
  getFinishTiming,
  resolveCarCollisions,
};
