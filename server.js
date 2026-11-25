const os = require("node:os");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const TOTAL_LAPS = 3;
const TRACK_RADIUS = 26;
const STEERING_RADIUS = 21.5;
const STEERING_RESPONSE = 8.5;
const START_ANGLE = -Math.PI / 2;
const FULL_TURN = Math.PI * 2;
const MAX_HUMAN_PLAYERS = 8;
const BOT_NAMES = ["Chispa", "Turbo", "Pistón", "Rayo", "Choco", "Nube", "Trueno"];
const CAR_COLORS = ["#30d6c1", "#ffb94b", "#ff6978", "#8a7cff", "#d9ed63", "#54a9ff", "#ff8ccc", "#f7f3e8"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
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

function crossedStartLine(previousAngle, currentAngle) {
  const angleChange = wrapAngle(currentAngle - previousAngle);
  const previousOffset = wrapAngle(previousAngle - START_ANGLE);
  const currentOffset = wrapAngle(currentAngle - START_ANGLE);
  return angleChange > 0 && previousOffset < 0 && currentOffset >= 0;
}

function isFinishCrossing(currentProgress, finishProgress, previousAngle, currentAngle) {
  return currentProgress >= finishProgress && crossedStartLine(previousAngle, currentAngle);
}

function createGameServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const cars = new Map();
  let hostId = null;
  let phase = "lobby";
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
    const gridIndex = cars.size;
    const theta = START_ANGLE - Math.floor(gridIndex / 2) * 0.2;
    const radius = TRACK_RADIUS + (gridIndex % 2 === 0 ? -3.4 : 3.4);
    const distanceToStartLine = ((START_ANGLE - theta) % FULL_TURN + FULL_TURN) % FULL_TURN;
    return {
      id,
      name,
      color,
      isBot,
      x: Math.cos(theta) * radius,
      z: Math.sin(theta) * radius,
      yaw: Math.PI - theta,
      speed: 0,
      steering: 0,
      input: { throttle: 0, brake: 0, steer: 0 },
      lastAngle: theta,
      progress: 0,
      lapsCompleted: 0,
      finishProgress: TOTAL_LAPS * FULL_TURN + distanceToStartLine,
      finishedAt: null,
    };
  }

  function addBots(count) {
    for (let index = 0; index < count; index += 1) {
      const name = BOT_NAMES[index % BOT_NAMES.length];
      const id = `bot-${index + 1}`;
      const bot = makeCar({
        id,
        name,
        color: CAR_COLORS[(index + 1) % CAR_COLORS.length],
        isBot: true,
      });
      cars.set(id, bot);
    }
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
    const radius = Math.hypot(car.x, car.z);
    if (car.isBot) {
      const theta = Math.atan2(car.z, car.x);
      const desiredYaw = Math.PI - theta;
      const headingError = wrapAngle(desiredYaw - car.yaw);
      car.input = {
        throttle: 1,
        brake: 0,
        steer: clamp(0.78 + (radius - TRACK_RADIUS) * 0.12 - headingError * 1.1, -1, 1),
      };
    }

    const onTrack = radius >= 18.5 && radius <= 34;
    const maxSpeed = onTrack ? 19 : 9;
    const acceleration = onTrack ? 11 : 6;
    if (car.input.brake > 0) {
      car.speed = Math.max(0, car.speed - 18 * car.input.brake * dt);
    } else if (car.input.throttle > 0) {
      car.speed = Math.min(maxSpeed, car.speed + acceleration * car.input.throttle * dt);
    } else {
      car.speed = Math.max(0, car.speed - 2.8 * dt);
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

    const angle = Math.atan2(car.z, car.x);
    const angleChange = wrapAngle(angle - car.lastAngle);
    car.progress = Math.max(0, car.progress + angleChange);
    car.lastAngle = angle;
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
        const previousAngle = car.lastAngle;
        updateCar(car, dt);
        const crossedLine = crossedStartLine(previousAngle, car.lastAngle);
        if (crossedLine) {
          car.lapsCompleted = Math.max(
            car.lapsCompleted,
            Math.min(TOTAL_LAPS, Math.floor((car.progress + 1e-6) / FULL_TURN))
          );
        }
        if (isFinishCrossing(car.progress, car.finishProgress, previousAngle, car.lastAngle)) {
          car.finishedAt = getCrossingTimeMs(previousProgress, car.progress, car.finishProgress, now, dt);
        }
      }
      if ([...cars.values()].every((car) => car.finishedAt !== null)) phase = "finished";
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
      if (humanCount >= MAX_HUMAN_PLAYERS) {
        acknowledge({ ok: false, error: "La sala está completa." });
        return;
      }

      const name = String(payload.name || "Piloto").trim().slice(0, 16) || "Piloto";
      const human = makeCar({
        id: socket.id,
        name,
        color: CAR_COLORS[humanCount % CAR_COLORS.length],
      });
      cars.set(socket.id, human);
      if (!hostId) {
        hostId = socket.id;
        addBots(clamp(Math.round(Number(payload.botCount) || 0), 0, BOT_NAMES.length));
      }
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
        countdownEndsAt = 0;
        raceStartedAt = 0;
      } else if (hostId === socket.id) {
        hostId = remainingHumans[0].id;
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
    console.log(`Circuito Cobalto disponible en http://localhost:${game.httpServer.address().port}`);
    for (const address of getLanAddresses()) {
      console.log(`Red local: http://${address}:${game.httpServer.address().port}`);
    }
  });
}

module.exports = {
  createGameServer,
  getCrossingTimeMs,
  getFinishTiming,
  isFinishCrossing,
};
